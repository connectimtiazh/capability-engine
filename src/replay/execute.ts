import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FileStore } from '../capability/store.js'
import type { Capability, ReplayResult, Step } from '../capability/schema.js'
import { loadPolicy, type PolicyConfig } from '../policy/allowlist.js'
import { redactParams } from '../policy/redact.js'
import { WebSurface, PolicyError } from '../surface/web.js'
import { Recorder } from '../evidence/recorder.js'
import { LeaseStore } from '../control/lease.js'
import { InterventionStore } from '../control/interventions.js'
import { detectBusinessOutcome } from './outcomes.js'
import { applyRecovery } from './recovery.js'
import { extractAnchored } from './extract.js'

export interface ReplayOptions {
  ref: string
  tenant: string
  params: Record<string, unknown>
  storeRoot: string
  headless?: boolean
  policyOverride?: PolicyConfig
  entryPointOverride?: string
}

function validatorFor(c: Capability): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, prop] of Object.entries(c.inputs.properties)) {
    let s: z.ZodString = z.string()
    const pattern = prop.pattern as string | undefined
    if (pattern) s = s.regex(new RegExp(pattern))
    shape[name] = c.inputs.required.includes(name) ? s : s.optional()
  }
  return z.object(shape)
}

function valueFor(step: Step, params: Record<string, unknown>): string | undefined {
  if (!step.value) return undefined
  if ('literal' in step.value) return step.value.literal
  return String(params[step.value.fromInput] ?? '')
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const store = new FileStore(opts.storeRoot)

  // F30: Initialize recorder first, in its own try/catch. If even this fails,
  // return a failed result rather than throwing.
  let runId: string
  let rec: Recorder
  try {
    runId = `rep_${randomUUID().slice(0, 8)}`
    rec = new Recorder(opts.storeRoot, runId)
    await rec.init()
  } catch (e) {
    return {
      status: 'failed', step: '(setup)', expected: 'an evidence directory',
      observed: String(e), class: 'surface_error', evidence: '',
    }
  }

  // F30: Everything else in a try/catch so setup errors are caught and returned,
  // not thrown.
  try {
    const policy = opts.policyOverride ?? (await loadPolicy())
    const sessionId = `sess_${runId}`

    const { capability, binding } = await store.resolveForTenant(opts.ref, opts.tenant)
    const entryPoint = opts.entryPointOverride ?? binding?.entryPoint

    // Ruling F10/F14: declare the sensitive values before anything about this run is
    // written, so every timeline line, screenshot and DOM snapshot is scrubbed —
    // never after the fact.
    const sensitive = Object.entries(capability.inputs.properties)
      .filter(([, p]) => p['x-sensitivity'] === 'pii' || p['x-sensitivity'] === 'secret')
      .map(([name]) => opts.params[name])
      .filter((v): v is string => typeof v === 'string')
    rec.setRedactions(sensitive)

    const redacted = redactParams(opts.params as Record<string, unknown>, capability.inputs)
    await rec.event('replay.start', { ref: opts.ref, tenant: opts.tenant, params: redacted, runId })

    const parsed = validatorFor(capability).safeParse(opts.params)
    if (!parsed.success) {
      const r: ReplayResult = {
        status: 'failed', step: '(inputs)', expected: 'parameters matching the declared input schema',
        observed: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        class: 'input_invalid', evidence: rec.dir,
      }
      await rec.event('replay.result', { result: r })
      await store.recordReplayAttempt(opts.ref, false, 'input_invalid')
      return r
    }
    if (!entryPoint) {
      const r: ReplayResult = {
        status: 'failed', step: '(binding)', expected: `a binding for tenant ${opts.tenant}`,
        observed: 'no binding and no entry point override', class: 'surface_error', evidence: rec.dir,
      }
      await rec.event('replay.result', { result: r })
      return r
    }

    const leases = new LeaseStore(opts.storeRoot)
    const interventions = new InterventionStore(opts.storeRoot)
    let lease = await leases.acquire(sessionId, 'agent')

    const surface = new WebSurface(policy, opts.headless ?? false)
    await surface.start()
    surface.setContext({ approvalState: capability.approval.state, leaseHeld: true })

    const outputs: Record<string, unknown> = {}

    const block = async (step: string, reason: string): Promise<ReplayResult> => {
      // F31: Guard evidence capture so failures don't convert blocked→failed.
      try {
        await rec.shot(surface, `blocked-${step}`)
        await rec.dom(surface, `blocked-${step}`)
      } catch (e) {
        await rec.event('evidence.capture_failed', { step, error: String(e) })
      }
      lease = await leases.release(sessionId, 'human:operator')
      const iv = await interventions.raise({
        runId, capability: opts.ref, step, reason,
        evidenceDir: rec.dir, redactedParams: redacted,
      })
      await rec.event('replay.blocked', { step, reason, interventionId: iv.id, leaseToken: lease.token })
      // F32: Count blocked as an attempt (no success).
      await store.recordReplayAttempt(opts.ref, false, null)
      return { status: 'blocked', interventionId: iv.id, reason, evidence: rec.dir }
    }

    // Ruling F22: the single place every `failed` result is built. Evidence capture
    // must tolerate a surface that is itself broken (e.g. the browser has already
    // crashed) — a failure to screenshot must never mask the failure being reported.
    const fail = async (
      step: string, expected: string, observed: string,
      cls: Extract<ReplayResult, { status: 'failed' }>['class'],
    ): Promise<ReplayResult> => {
      try {
        await rec.shot(surface, `failed-${step}`)
        await rec.dom(surface, `failed-${step}`)
      } catch (e) {
        await rec.event('evidence.capture_failed', { step, error: String(e) })
      }
      const r: ReplayResult = { status: 'failed', step, expected, observed, class: cls, evidence: rec.dir }
      await rec.event('replay.result', { result: r })
      await store.recordReplayAttempt(opts.ref, false, `${cls} at ${step}`)
      return r
    }

    try {
      await surface.open(entryPoint)

      for (const step of capability.steps) {
        await rec.event('step.start', { id: step.id, intent: step.intent, action: step.action })

        // A declared outcome can appear at any point, so it is checked before each
        // step rather than only at the end. "No record found" is an answer, and an
        // answer should not have to wait for the remaining steps to fail.
        const outcome = await detectBusinessOutcome(surface, capability.businessOutcomes)
        if (outcome) {
          const r: ReplayResult = {
            status: 'business_outcome', code: outcome.code,
            message: outcome.message ?? outcome.code, evidence: rec.dir,
          }
          await rec.event('replay.result', { result: r })
          await store.recordReplayAttempt(opts.ref, true, null)
          return r
        }

        if (step.action === 'read') {
          // Ruling F22: extraction returns the typed value looked up beside a
          // declared anchor, not the raw screen text — the same capability then
          // returns a number for every member, not a screen of text.
          const anchor = step.target?.anchor
          if (!anchor || !step.extract) {
            return await fail(step.id, 'an extraction anchor (a label beside the value)', 'extract step has no anchor', 'checkpoint_failed')
          }
          const text = await surface.readText(step.target!)
          const got = extractAnchored(text, anchor.rowHeader, step.extract.as)
          if (!got.ok) {
            return await fail(step.id, `a ${step.extract.as} beside "${anchor.rowHeader}"`, got.observed, 'checkpoint_failed')
          }
          outputs[step.extract.into] = got.value
          await rec.event('step.extract', { id: step.id, into: step.extract.into })
          continue
        }

        let resolution = await surface.resolve(step.target!)

        if (resolution.kind === 'none') {
          const recovered = await applyRecovery(surface, step.onError, { entryPoint })
          if (recovered === 'recovered') {
            await rec.event('step.recovered', { id: step.id })
            const again = await detectBusinessOutcome(surface, capability.businessOutcomes)
            if (again) {
              const r: ReplayResult = { status: 'business_outcome', code: again.code, message: again.message ?? again.code, evidence: rec.dir }
              await store.recordReplayAttempt(opts.ref, true, null)
              return r
            }
            resolution = await surface.resolve(step.target!)
          }
        }

        if (resolution.kind === 'ambiguous') {
          // Two candidates is never an action. On a read it is a hard failure; on a
          // mutate a person choosing between them is a legitimate intervention.
          if (capability.risk.class === 'mutate') return await block(step.id, `resolver_ambiguous:${resolution.count}`)
          return await fail(
            step.id, `exactly one ${step.target!.role} named "${step.target!.name}"`,
            `${resolution.count} matches`, 'resolver_ambiguous',
          )
        }

        if (resolution.kind === 'none') {
          // Unknown means stop. An unrecognised screen is exactly where improvising
          // stops being automation and starts being a liability.
          return await block(step.id, 'unrecognised_state_or_missing_control')
        }

        if (resolution.via !== 'primary' && binding) {
          await store.recordDrift(opts.tenant, capability.key, step.id, resolution.via)
          await rec.event('step.drift', { id: step.id, via: resolution.via })
        }

        try {
          await surface.act(step.action, resolution.node, valueFor(step, opts.params as Record<string, unknown>))
        } catch (e) {
          if (e instanceof PolicyError && e.verdict === 'HOLD') return await block(step.id, e.reason)
          if (e instanceof PolicyError) {
            return await fail(step.id, 'an action permitted by policy', e.reason, 'policy_denied')
          }
          throw e
        }

        let cp = await surface.checkpointHolds(step.checkpoint)
        if (!cp.ok) {
          const outcomeNow = await detectBusinessOutcome(surface, capability.businessOutcomes)
          if (outcomeNow) {
            const r: ReplayResult = { status: 'business_outcome', code: outcomeNow.code, message: outcomeNow.message ?? outcomeNow.code, evidence: rec.dir }
            await rec.event('replay.result', { result: r })
            await store.recordReplayAttempt(opts.ref, true, null)
            return r
          }
          const recovered = await applyRecovery(surface, step.onError, { entryPoint })
          if (recovered === 'recovered') cp = await surface.checkpointHolds(step.checkpoint)
        }

        if (!cp.ok) {
          return await fail(step.id, JSON.stringify(step.checkpoint), cp.observed, 'checkpoint_failed')
        }

        await rec.event('step.ok', { id: step.id })
      }

      const success = await surface.checkpointHolds(capability.successCondition)
      if (!success.ok) {
        return await fail('(successCondition)', JSON.stringify(capability.successCondition), success.observed, 'checkpoint_failed')
      }

      const r: ReplayResult = { status: 'success', outputs, evidence: rec.dir }
      await rec.event('replay.result', { result: { ...r, outputs: '[see run]' } })
      await store.recordReplayAttempt(opts.ref, true, null)
      return r
    } catch (e) {
      if (e instanceof PolicyError && e.verdict === 'HOLD') return await block('(surface)', e.reason)
      return await fail('(run)', 'the recorded flow to complete', String(e), 'surface_error')
    } finally {
      try {
        await surface.close()
      } catch {
        // Surface may never have started. Suppress to avoid masking the real error.
      }
    }
  } catch (e) {
    // F30: Setup errors (before try block) — caught and classified.
    const msg = String(e)
    await rec.event('replay.error', { error: msg })

    // F30: Classify setup errors: missing capability is input_invalid, others are surface_error.
    if (/capability not found/i.test(msg)) {
      const r: ReplayResult = {
        status: 'failed', step: '(capability)', expected: `capability ${opts.ref}`,
        observed: msg, class: 'input_invalid', evidence: rec.dir,
      }
      await rec.event('replay.result', { result: r })
      // Don't try to record stats on a capability that doesn't exist.
      try {
        await store.recordReplayAttempt(opts.ref, false, 'input_invalid')
      } catch {
        // Capability doesn't exist, can't record stats.
      }
      return r
    }

    const r: ReplayResult = {
      status: 'failed', step: '(setup)', expected: 'the run to initialize',
      observed: msg, class: 'surface_error', evidence: rec.dir,
    }
    await rec.event('replay.result', { result: r })
    try {
      await store.recordReplayAttempt(opts.ref, false, 'setup_failed')
    } catch {
      // Capability may not exist yet; suppress error.
    }
    return r
  }
}
