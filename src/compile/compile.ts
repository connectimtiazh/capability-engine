import { classifyAction } from '../policy/allowlist.js'
import { CapabilitySchema, type Capability, type Checkpoint, type Step, type BusinessOutcome } from '../capability/schema.js'
import type { Trace, TraceStep } from '../discover/loop.js'

/** Runtime conditions worth declaring as outcomes when discovery happened to see
 *  them. Detectors are authored here, at compile time, and then only ever matched
 *  at replay — the model never interprets a result at run time. */
const KNOWN_OUTCOMES: { code: string; text: string; message: string }[] = [
  { code: 'MEMBER_NOT_FOUND', text: 'No record found', message: 'No member exists with that number.' },
  { code: 'ACCOUNT_RESTRICTED', text: 'Access restricted', message: 'This member requires elevated entitlements.' },
]

/** The most distinctive short line on the screen after an action becomes that step's
 *  checkpoint. Lines carrying any value that varies per invocation — a supplied
 *  parameter, or a digit-bearing token from a declared extraction — are rejected. A
 *  checkpoint must assert structure ("Share Balance" is on screen), never content
 *  (the balance itself, or a date): a checkpoint anchored on content would only ever
 *  pass for the record it was recorded against, which defeats parameterisation and
 *  replayability entirely. If nothing on screen is safe to anchor on, compilation
 *  refuses rather than silently emitting a capability that can only replay once.
 *  Novelty uses the same substring predicate replay uses to verify the checkpoint
 *  (`WebSurface.checkpointHolds` tests `text-present` with `includes`), so a candidate
 *  that already appears anywhere in the prior screen's text — even as a substring of a
 *  longer prior line — can never be mistaken for evidence that the action did anything. */
function distinctiveLine(finalText: string, priorText: string, volatile: string[] = []): string {
  const carriesVolatile = (l: string): boolean =>
    volatile.some((v) => v.length >= 3 && l.includes(v))
  const units = (t: string): string[] => t.split(/[\n\t]/).map((l) => l.trim())
  const lines = units(finalText)
  const candidates = lines.filter(
    (l) => l.length >= 4 && l.length <= 60 && !priorText.includes(l) && !carriesVolatile(l),
  )
  if (candidates[0]) return candidates[0]
  const safe = lines.filter((l) => l.length >= 4 && !carriesVolatile(l))
  if (safe[0]) return safe[0]
  throw new Error(
    'cannot derive a checkpoint: every line on the result screen carries a value that ' +
      'varies per invocation. A capability with a content-anchored checkpoint would only ' +
      'ever pass for the record it was recorded against.',
  )
}

function checkpointFor(step: TraceStep, prior: string, volatile: string[]): Checkpoint {
  if (step.action === 'fill') {
    return { kind: 'field-has-value', role: step.target.role, name: step.target.name ?? '', framePath: step.target.framePath }
  }
  return { kind: 'text-present', text: distinctiveLine(step.textAfter, prior, volatile), framePath: step.target.framePath }
}

export function compile(
  trace: Trace,
  opts: { key: string; params: Record<string, string>; version?: string },
): Capability {
  // Invert the supplied params so a recorded literal can be lifted back into the
  // parameter it came from. Longest first, so "40021" wins over "4".
  const byValue = Object.entries(opts.params).sort((a, b) => b[1].length - a[1].length)
  const paramValues = Object.values(opts.params)
  // Tokens carrying a digit are the parts of a declared extraction that vary per
  // invocation: a balance, a date, an account number. A checkpoint must never
  // anchor on one — this stays declaration-based (only what the run declared as an
  // extracted output is treated as volatile), not a heuristic guess at what "looks"
  // sensitive.
  const extractedTokens = Object.values(trace.extracted)
    .flatMap((e) => e.value.split(/\s+/))
    .filter((t) => t.length >= 3 && /\d/.test(t))
  const volatile = [...paramValues, ...extractedTokens]

  /** Rewrites a recorded literal into its parameter name, so human-facing text
   *  describes the capability rather than the one record it was recorded against. */
  const parameterise = (text: string): string => {
    let out = text
    // Longest value first, for the same reason byValue sorts: a shorter value that is a
    // substring of a longer one would otherwise consume it and leave the longer unmatched.
    const byLength = Object.entries(opts.params).sort((a, b) => b[1].length - a[1].length)
    for (const [name, value] of byLength) {
      if (value.length >= 3) out = out.split(value).join(`{${name}}`)
    }
    return out
  }

  const steps: Step[] = trace.steps.map((s, i) => {
    const prior = i === 0 ? '' : trace.steps[i - 1]!.textAfter
    const match = s.value ? byValue.find(([, v]) => v === s.value) : undefined

    const step: Step = {
      id: `s${i + 1}`,
      // Human-facing text is parameterised; the target descriptor below is never
      // touched by parameterise — target.name/target.labelText are how replay
      // locates the control, and rewriting a locator would break resolution.
      intent: parameterise(s.intent),
      action: s.action,
      target: {
        ...s.target,
        fallbacks: s.target.fallbacks.length
          ? s.target.fallbacks
          : s.target.role === 'textbox'
            ? [{ strategy: 'nth-input-in-form', form: 0, index: 0 }]
            : [],
      },
      checkpoint: checkpointFor(s, prior, volatile),
      onError: [
        { when: 'dialog-present', match: 'Message of the Day', do: 'dismiss' },
        { when: 'session-expired', do: 'reauth' },
        { when: 'timeout', do: 'retry', max: 2, backoffMs: 500 },
      ],
      timeoutMs: 8000,
    }

    if (s.value !== undefined) {
      step.value = match ? { fromInput: match[0] } : { literal: s.value }
    }
    return step
  })

  const inputs: Capability['inputs'] = { type: 'object', required: [], properties: {} }
  for (const [name, value] of Object.entries(opts.params)) {
    inputs.required.push(name)
    inputs.properties[name] = {
      type: 'string',
      pattern: /^\d+$/.test(value) ? `^[0-9]{${value.length}}$` : undefined,
      // Anything a caller supplies per invocation is treated as identifying data
      // until a human reviewing the artifact says otherwise. Over-redacting is
      // recoverable; under-redacting regulated data is not.
      'x-sensitivity': 'pii',
    }
  }

  const outputs: Capability['outputs'] = { type: 'object', required: [], properties: {} }
  const extractSteps: Step[] = []
  let n = steps.length
  for (const [name, e] of Object.entries(trace.extracted)) {
    outputs.required.push(name)
    outputs.properties[name] = { type: e.as === 'number' ? 'number' : 'string' }
    extractSteps.push({
      id: `s${++n}`,
      intent: parameterise(`Read ${name} from the result screen`),
      action: 'read',
      target: e.from,
      extract: { into: name, as: e.as as 'string' | 'number' | 'date' },
      checkpoint: { kind: 'text-present', text: distinctiveLine(trace.finalText, '', volatile), framePath: e.from.framePath },
      onError: [{ when: 'timeout', do: 'retry', max: 2, backoffMs: 500 }],
      timeoutMs: 8000,
    })
  }

  const businessOutcomes: BusinessOutcome[] = KNOWN_OUTCOMES.map((o) => ({
    code: o.code,
    detect: { kind: 'text-present', text: o.text } as Checkpoint,
    terminal: true,
    message: o.message,
  }))

  const parameterisedGoal = parameterise(trace.goal)

  const capability: Capability = {
    apiVersion: 'capability/v1',
    key: opts.key,
    version: opts.version ?? '1.0.0',
    title: parameterisedGoal,
    description: `Discovered from the goal: ${parameterisedGoal}`,
    surface: { kind: 'web' },
    vendor: { product: opts.key.split('/')[0] ?? 'unknown' },
    inputs,
    outputs,
    steps: [...steps, ...extractSteps],
    successCondition: {
      kind: 'text-present',
      text: distinctiveLine(trace.finalText, trace.steps[0]?.textAfter ?? '', volatile),
    },
    businessOutcomes,
    risk: {
      class: trace.steps.some((s) => classifyAction(s.action) === 'mutate') ? 'mutate' : 'read',
      irreversible: false,
      requiresApproval: false,
    },
    provenance: {
      discoveredBy: trace.model,
      discoveryRunId: trace.runId,
      recordedAt: new Date().toISOString(),
      humanEdits: [],
    },
    approval: { state: 'draft', replayStats: { attempts: 0, successes: 0, lastFailure: null } },
  }

  return CapabilitySchema.parse(JSON.parse(JSON.stringify(capability)))
}
