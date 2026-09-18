import { randomUUID } from 'node:crypto'
import type { ActionKind, TargetDescriptor } from '../capability/schema.js'
import { loadPolicy, type PolicyConfig } from '../policy/allowlist.js'
import { WebSurface } from '../surface/web.js'
import { Recorder } from '../evidence/recorder.js'
import type { ModelClient } from './model.js'

export interface TraceStep {
  intent: string
  action: ActionKind
  target: TargetDescriptor
  resolvedVia: string
  value?: string
  valueLiteral?: string
  urlAfter: string
  textAfter: string
}

export interface Trace {
  goal: string
  runId: string
  entryPoint: string
  model: string
  steps: TraceStep[]
  extracted: Record<string, { value: string; as: string; from: TargetDescriptor }>
  observedOutcomes: { text: string; url: string }[]
  finalText: string
}

export interface DiscoveryOptions {
  goal: string
  entryPoint: string
  model: ModelClient
  storeRoot: string
  headless?: boolean
  maxSteps?: number
  policyOverride?: PolicyConfig
  params?: Record<string, string>
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<Trace> {
  const policy = opts.policyOverride ?? (await loadPolicy())
  const runId = `disc_${randomUUID().slice(0, 8)}`
  const rec = new Recorder(opts.storeRoot, runId)
  await rec.init()
  rec.setRedactions(Object.values(opts.params ?? {}))

  const surface = new WebSurface(policy, opts.headless ?? false)
  await surface.start()
  // Discovery is exploratory and attended by definition, so it runs approved.
  // Nothing here is unattended; a person launched it and is watching.
  surface.setContext({ approvalState: 'approved', leaseHeld: true })

  const trace: Trace = {
    goal: opts.goal, runId, entryPoint: opts.entryPoint, model: opts.model.name,
    steps: [], extracted: {}, observedOutcomes: [], finalText: '',
  }
  const history: string[] = []
  const maxSteps = opts.maxSteps ?? 15

  try {
    await rec.event('discovery.start', { goal: opts.goal, entryPoint: opts.entryPoint, model: opts.model.name })
    await surface.open(opts.entryPoint)

    for (let i = 0; i < maxSteps; i++) {
      const observation = await surface.observe()
      trace.observedOutcomes.push({ text: observation.frames.map((f) => f.text).join('\n'), url: observation.url })

      const proposal = await opts.model.propose({ goal: opts.goal, observation, history })
      await rec.event('model.proposal', { step: i, proposal })

      if (proposal.kind === 'stuck') {
        await rec.shot(surface, `stuck-${i}`)
        await rec.dom(surface, `stuck-${i}`)
        throw new Error(`stuck: ${proposal.why}`)
      }

      if (proposal.kind === 'done') {
        trace.finalText = observation.frames.map((f) => f.text).join('\n')
        await rec.event('discovery.done', { summary: proposal.summary })
        await rec.shot(surface, 'final')
        return trace
      }

      if (proposal.kind === 'extract') {
        const text = await surface.readText(proposal.from)
        trace.extracted[proposal.name] = { value: text, as: proposal.as, from: proposal.from }
        history.push(`extract ${proposal.name}`)
        await rec.event('discovery.extract', { name: proposal.name })
        continue
      }

      const resolution = await surface.resolve(proposal.target)
      if (resolution.kind !== 'one') {
        await rec.shot(surface, `unresolved-${i}`)
        history.push(`FAILED to resolve ${JSON.stringify(proposal.target)} (${resolution.kind})`)
        await rec.event('discovery.unresolved', { step: i, resolution })
        continue
      }

      await surface.act(proposal.action, resolution.node, proposal.value)
      const after = await surface.observe()

      trace.steps.push({
        intent: proposal.intent,
        action: proposal.action,
        target: proposal.target,
        resolvedVia: resolution.via,
        value: proposal.value,
        valueLiteral: proposal.value,
        urlAfter: after.url,
        textAfter: after.frames.map((f) => f.text).join('\n'),
      })
      history.push(`${proposal.action} ${JSON.stringify(proposal.target.name ?? '')} -> ${after.url}`)
      await rec.event('discovery.acted', { step: i, action: proposal.action, via: resolution.via })
    }

    await rec.shot(surface, 'budget-exhausted')
    throw new Error(`step budget of ${maxSteps} exhausted without reaching the goal`)
  } finally {
    await surface.close()
  }
}
