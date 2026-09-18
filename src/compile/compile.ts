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
 *  checkpoint. Lines carrying a supplied parameter value are rejected: a checkpoint
 *  anchored on "Member A. Whitfield (40021)" would only ever pass for the member the
 *  run was recorded against, which defeats parameterisation entirely. */
function distinctiveLine(finalText: string, priorText: string, paramValues: string[] = []): string {
  const carriesParam = (l: string): boolean =>
    paramValues.some((v) => v.length >= 3 && l.includes(v))
  const prior = new Set(priorText.split('\n').map((l) => l.trim()))
  const lines = finalText.split('\n').map((l) => l.trim())
  const candidates = lines.filter(
    (l) => l.length >= 4 && l.length <= 60 && !prior.has(l) && !carriesParam(l),
  )
  if (candidates[0]) return candidates[0]
  const safe = lines.filter((l) => l.length >= 4 && !carriesParam(l))
  return safe[0] ?? finalText.trim().slice(0, 40)
}

function checkpointFor(step: TraceStep, prior: string, paramValues: string[]): Checkpoint {
  if (step.action === 'fill') {
    return { kind: 'field-has-value', role: step.target.role, name: step.target.name ?? '', framePath: step.target.framePath }
  }
  return { kind: 'text-present', text: distinctiveLine(step.textAfter, prior, paramValues), framePath: step.target.framePath }
}

export function compile(
  trace: Trace,
  opts: { key: string; params: Record<string, string>; version?: string },
): Capability {
  // Invert the supplied params so a recorded literal can be lifted back into the
  // parameter it came from. Longest first, so "40021" wins over "4".
  const byValue = Object.entries(opts.params).sort((a, b) => b[1].length - a[1].length)
  const paramValues = Object.values(opts.params)

  const steps: Step[] = trace.steps.map((s, i) => {
    const prior = i === 0 ? '' : trace.steps[i - 1]!.textAfter
    const match = s.value ? byValue.find(([, v]) => v === s.value) : undefined

    const step: Step = {
      id: `s${i + 1}`,
      intent: s.intent,
      action: s.action,
      target: {
        ...s.target,
        fallbacks: s.target.fallbacks.length
          ? s.target.fallbacks
          : s.target.role === 'textbox'
            ? [{ strategy: 'nth-input-in-form', form: 0, index: 0 }]
            : [],
      },
      checkpoint: checkpointFor(s, prior, paramValues),
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
      intent: `Read ${name} from the result screen`,
      action: 'read',
      target: e.from,
      extract: { into: name, as: e.as as 'string' | 'number' | 'date' },
      checkpoint: { kind: 'text-present', text: distinctiveLine(trace.finalText, '', paramValues), framePath: e.from.framePath },
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

  const capability: Capability = {
    apiVersion: 'capability/v1',
    key: opts.key,
    version: opts.version ?? '1.0.0',
    title: trace.goal,
    description: `Discovered from the goal: ${trace.goal}`,
    surface: { kind: 'web' },
    vendor: { product: opts.key.split('/')[0] ?? 'unknown' },
    inputs,
    outputs,
    steps: [...steps, ...extractSteps],
    successCondition: {
      kind: 'text-present',
      text: distinctiveLine(trace.finalText, trace.steps[0]?.textAfter ?? '', paramValues),
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
