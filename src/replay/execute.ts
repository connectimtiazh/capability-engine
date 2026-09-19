import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FileStore } from '../capability/store.js'
import type { Capability, ReplayResult, Step } from '../capability/schema.js'
import { loadPolicy, classifyAction, type PolicyConfig } from '../policy/allowlist.js'
import { redactParams } from '../policy/redact.js'
import { WebSurface, PolicyError, SurfaceTimeoutError } from '../surface/web.js'
import type { OperatorHandle } from '../surface/types.js'
import { Recorder } from '../evidence/recorder.js'
import { LeaseStore } from '../control/lease.js'
import { InterventionStore, type Intervention } from '../control/interventions.js'
import { detectBusinessOutcome } from './outcomes.js'
import { applyRecovery, type TimeoutRungState } from './recovery.js'
import { extractAnchored } from './extract.js'

export interface ReplayOptions {
  ref: string
  tenant: string
  params: Record<string, unknown>
  storeRoot: string
  headless?: boolean
  policyOverride?: PolicyConfig
  entryPointOverride?: string
  waitForHuman?: boolean          // default false: keep today's return-and-close behaviour
  humanTimeoutMs?: number         // default 600_000
  maxInterventions?: number       // default 3
  onIntervention?: (iv: Intervention, operator: OperatorHandle) => Promise<void>
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

  // F34a: Best-effort timeline write. Used only on paths that are already returning a failure
  // or a block: losing one log line is survivable, losing the structured result is not.
  const note = async (type: string, data: Record<string, unknown>): Promise<void> => {
    try { await rec.event(type, data) } catch { /* evidence is best-effort while failing */ }
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
    surface.setContext({
      approvalState: capability.approval.state, leaseHeld: true,
      businessRisk: capability.risk.business, businessSetBy: capability.risk.businessSetBy,
    })

    // Resolves an input parameter's name back to the exact value this invocation
    // supplied, so a field-value-matches-input checkpoint can prove the control
    // holds *this* run's value rather than merely something.
    const resolveInput = (inputName: string): string | undefined => {
      const v = opts.params[inputName]
      return v === undefined ? undefined : String(v)
    }

    const outputs: Record<string, unknown> = {}

    // Per-step timeout-rung attempt counts, keyed by step id and kept for the whole
    // run so a step revisited via `i--` (a block/resume retry) does not get a fresh
    // `max` budget it hasn't earned. `remaining` is the one place a deadline turns
    // into a Playwright-shaped budget: never negative, so a step whose clock has
    // already run out still hands surface calls a legal (zero) timeout rather than
    // a value that would flip Playwright's "no timeout" meaning.
    const timeoutAttemptsByStep = new Map<string, TimeoutRungState>()
    const remaining = (deadline: number): number => Math.max(0, deadline - Date.now())

    let interventionsUsed = 0
    let approvedStep: string | null = null   // one-shot human approval, see below

    // C1: the screen is not this run's own product the instant control comes back
    // from a human. Set wherever `block()` resolves and the loop re-enters the same
    // step index; cleared once the step's own target re-resolves on the live page.
    // While it is true, a business-outcome read off the current screen would be
    // attributing to this run's actions a page the human may have navigated on
    // their own — see the fix note at the top of the loop below.
    let justResumed = false

    const block = async (step: string, reason: string): Promise<ReplayResult | 'resumed'> => {
      // F31: Guard evidence capture so failures don't convert blocked→failed.
      try {
        await rec.shot(surface, `blocked-${step}`)
        await rec.dom(surface, `blocked-${step}`)
      } catch (e) {
        await note('evidence.capture_failed', { step, error: String(e) })
      }

      interventionsUsed++
      const overBudget = interventionsUsed > (opts.maxInterventions ?? 3)

      // Evidence is captured while the agent still holds the lease, then control moves.
      const urlBefore = surface.url()
      lease = await leases.release(sessionId, 'human:operator', lease.token)
      surface.setContext({ leaseHeld: false })
      const iv = await interventions.raise({
        runId, capability: opts.ref, step, reason,
        evidenceDir: rec.dir, redactedParams: redacted,
      })
      await note('replay.blocked', { step, reason, interventionId: iv.id, leaseToken: lease.token })
      await note('control.handoff', { interventionId: iv.id, step, reason, token: lease.token })

      // F35: replayStats counts invocations, not pauses. A pause that goes on to be
      // resumed is not a terminal outcome, so it must not record an attempt here —
      // only the paths below that actually return `blocked` (the run's final word)
      // may. Success and business_outcome record their own attempt at their own
      // return, and fail() records its own, so every terminal path records exactly
      // once and no path records twice.
      if (overBudget) {
        const r: ReplayResult = { status: 'blocked', interventionId: iv.id, reason: 'intervention_budget_exhausted', evidence: rec.dir }
        await note('replay.result', { result: r })
        await store.recordReplayAttempt(opts.ref, false, null)
        return r
      }

      if (!opts.waitForHuman) {
        const r: ReplayResult = { status: 'blocked', interventionId: iv.id, reason, evidence: rec.dir }
        await note('replay.result', { result: r })
        await store.recordReplayAttempt(opts.ref, false, null)
        return r
      }

      if (opts.onIntervention) {
        void opts.onIntervention(iv, surface.operatorHandle())
          .catch((e) => note('operator.error', { interventionId: iv.id, error: String(e) }))
      }

      const deadline = Date.now() + (opts.humanTimeoutMs ?? 600_000)
      let resolved: Intervention | null = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))
        const current = await interventions.get(iv.id)
        if (current.state === 'resolved') { resolved = current; break }
      }

      if (!resolved) {
        await note('control.timeout', { interventionId: iv.id })
        const r: ReplayResult = {
          status: 'blocked', interventionId: iv.id,
          reason: `${reason}; no operator resolved it within ${opts.humanTimeoutMs ?? 600_000}ms`,
          evidence: rec.dir,
        }
        await note('replay.result', { result: r })
        await store.recordReplayAttempt(opts.ref, false, null)
        return r
      }

      // Take the wheel back with a fresh token, and record what moved while we were out.
      lease = await leases.acquire(sessionId, 'agent', lease.token)
      surface.setContext({ leaseHeld: true })
      const urlAfter = surface.url()
      await interventions.resolve(iv.id, resolved.note ?? '', [
        { urlBefore, urlAfter, note: resolved.note ?? '' },
      ])
      await note('control.handback', { interventionId: iv.id, token: lease.token, urlBefore, urlAfter, note: resolved.note ?? '' })

      // A HOLD is a decision a human owes us; resolving it grants that ONE step, once.
      if (reason.startsWith('unapproved_mutation')) {
        approvedStep = step
        await note('human.approved_step', { interventionId: iv.id, step })
      }
      return 'resumed' as const
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
        await note('evidence.capture_failed', { step, error: String(e) })
      }
      const r: ReplayResult = { status: 'failed', step, expected, observed, class: cls, evidence: rec.dir }
      await note('replay.result', { result: r })
      await store.recordReplayAttempt(opts.ref, false, `${cls} at ${step}`)
      return r
    }

    try {
      await surface.open(entryPoint)

      for (let i = 0; i < capability.steps.length; i++) {
        const step = capability.steps[i]!
        // F41: the artifact declares `step.timeoutMs` per step; this is where it
        // finally gets read. Every surface call made while working on this step —
        // resolve, act, checkpoint, extract — is bounded by what remains of it.
        const deadline = Date.now() + step.timeoutMs
        let timeoutState = timeoutAttemptsByStep.get(step.id)
        if (!timeoutState) {
          timeoutState = { count: 0 }
          timeoutAttemptsByStep.set(step.id, timeoutState)
        }
        await rec.event('step.start', { id: step.id, intent: step.intent, action: step.action })

        // A declared outcome can appear at any point, so it is checked before each
        // step rather than only at the end. "No record found" is an answer, and an
        // answer should not have to wait for the remaining steps to fail.
        //
        // C1 fix: NOT when the previous iteration just came back from a handback.
        // The screen is not this run's own product until the engine has re-resolved
        // its own step's target on it — a human holding the lease can navigate
        // anywhere, and reading an outcome off whatever they left on screen before
        // this run has acted again is exactly the bug this guard closes (see
        // evidence/rep_51bad52a: control.handback lands on /member/inquire, and the
        // old code read "No record found" there without ever re-clicking Inquire).
        if (!justResumed) {
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
        }

        if (step.action === 'read') {
          // Ruling F22: extraction returns the typed value looked up beside a
          // declared anchor, not the raw screen text — the same capability then
          // returns a number for every member, not a screen of text.
          const anchor = step.target?.anchor
          if (!anchor || !step.extract) {
            return await fail(step.id, 'an extraction anchor (a label beside the value)', 'extract step has no anchor', 'checkpoint_failed')
          }
          let text: string
          try {
            text = await surface.readText(step.target!, { timeoutMs: remaining(deadline) })
          } catch (e) {
            if (e instanceof SurfaceTimeoutError) {
              return await fail(
                step.id, `a ${step.extract.as} beside "${anchor.rowHeader}" within ${step.timeoutMs}ms`,
                String(e), 'step_timeout',
              )
            }
            throw e
          }
          const got = extractAnchored(text, anchor.rowHeader, step.extract.as)
          if (!got.ok) {
            return await fail(step.id, `a ${step.extract.as} beside "${anchor.rowHeader}"`, got.observed, 'checkpoint_failed')
          }
          outputs[step.extract.into] = got.value
          await rec.event('step.extract', { id: step.id, into: step.extract.into })
          continue
        }

        let resolution = await surface.resolve(step.target!, { timeoutMs: remaining(deadline) })

        // C1 fix: this is the re-establishment the guard above is waiting for. A
        // handback does not make the screen trustworthy again by itself — only
        // finding this step's own target on it does. If it resolves, the run is back
        // on its own ground and outcomes are trustworthy again from here on. If it
        // does not, a human moved the page somewhere this step cannot pick up from,
        // and that is reported honestly instead of falling into any of the ordinary
        // none/ambiguous handling below (recovery, drift, etc. all assume the run
        // itself produced the current screen, which is exactly what is in doubt here).
        if (justResumed) {
          if (resolution.kind === 'one') {
            justResumed = false
          } else {
            const outcome = await block(step.id, 'page_moved_during_handoff')
            if (outcome !== 'resumed') return outcome
            justResumed = true
            i--
            continue
          }
        }

        // Bounded resolve-recovery: keep applying whatever the step declares while
        // the target still hasn't resolved, but never past this step's deadline and
        // never past the `timeout` rung's own `max` — `applyRecovery` enforces the
        // latter internally via `timeoutState`, this loop enforces the former.
        while (resolution.kind === 'none' && Date.now() < deadline) {
          const recovered = await applyRecovery(surface, step.onError, { entryPoint, deadline }, timeoutState)
          if (recovered.kind === 'not-applicable') break
          // C4: only `dialog-present`/`session-expired` actually cleared something;
          // the bare `timeout` rung just waited, so it is logged as a wait, not a
          // recovery (see evidence/rep_5ecd18a5, where this line previously claimed
          // a recovery for a rung that fixed nothing).
          await rec.event(recovered.kind === 'recovered' ? 'step.recovered' : 'step.waited', { id: step.id, rung: recovered.rung })
          const again = await detectBusinessOutcome(surface, capability.businessOutcomes)
          if (again) {
            const r: ReplayResult = { status: 'business_outcome', code: again.code, message: again.message ?? again.code, evidence: rec.dir }
            await store.recordReplayAttempt(opts.ref, true, null)
            return r
          }
          const budget = remaining(deadline)
          if (budget <= 0) break
          resolution = await surface.resolve(step.target!, { timeoutMs: budget })
        }

        if (resolution.kind === 'none' && Date.now() >= deadline) {
          // The target never showed up and the step's own clock ran out while
          // recovery was still trying. This is a distinct failure from the
          // "unrecognised screen" case below: the run never got a chance to act, so
          // treating it as "acted and got the wrong screen" would misdiagnose it —
          // and blocking for a human here would wait forever on a control that was
          // never going to appear before the deadline regardless of how long anyone
          // waits.
          return await fail(
            step.id,
            `${step.target!.role} named "${step.target!.name ?? step.target!.labelText ?? ''}" within ${step.timeoutMs}ms`,
            `not resolved after ${timeoutState.count} timeout-recovery attempt(s)`,
            'step_timeout',
          )
        }

        if (resolution.kind === 'ambiguous') {
          // Two candidates is never an action. On a read it is a hard failure; on a
          // mutate a person choosing between them is a legitimate intervention.
          // C3: keyed on this step's own action, not the capability-wide risk class —
          // a read step inside an otherwise-mutating capability must still fail hard
          // on ambiguity, matching REPORT §5.
          if (classifyAction(step.action) === 'mutate') {
            const outcome = await block(step.id, `resolver_ambiguous:${resolution.count}`)
            if (outcome !== 'resumed') return outcome
            justResumed = true
            i--
            continue
          }
          return await fail(
            step.id, `exactly one ${step.target!.role} named "${step.target!.name}"`,
            `${resolution.count} matches`, 'resolver_ambiguous',
          )
        }

        if (resolution.kind === 'none') {
          // Unknown means stop. An unrecognised screen is exactly where improvising
          // stops being automation and starts being a liability.
          const outcome = await block(step.id, 'unrecognised_state_or_missing_control')
          if (outcome !== 'resumed') return outcome
          justResumed = true
          i--
          continue
        }

        if (resolution.via !== 'primary' && binding) {
          await store.recordDrift(opts.tenant, capability.key, step.id, resolution.via)
          await rec.event('step.drift', { id: step.id, via: resolution.via })
        }

        // The token is only a guarantee if something checks it. If the lease moved while we
        // were working, someone else is driving and we must not act.
        if (!(await leases.holds(sessionId, 'agent', lease.token))) {
          const outcome = await block(step.id, 'lease_lost')
          if (outcome !== 'resumed') return outcome
          justResumed = true
          i--
          continue
        }
        const oneShot = approvedStep === step.id
        if (oneShot) surface.setContext({ approvalState: 'approved' })
        // `cp` starts pessimistic: if the action itself times out, there is no
        // checkpoint read to attempt, and the recovery loop below is exactly the
        // same "wait, maybe the screen catches up" mechanism whether it was the
        // checkpoint that failed or the action that never finished.
        let cp: { ok: boolean; observed: string } = { ok: false, observed: '' }
        let actionTimedOut = false
        try {
          await surface.act(
            step.action, resolution.node, valueFor(step, opts.params as Record<string, unknown>),
            { timeoutMs: remaining(deadline) },
          )
        } catch (e) {
          if (e instanceof PolicyError && e.verdict === 'HOLD') {
            // This is the C1 site: an unapproved mutation (e.g. the click on a still-
            // draft capability) is held here, and the demo in evidence/rep_51bad52a
            // shows exactly this rung's handback landing on a page the human moved.
            const outcome = await block(step.id, e.reason)
            if (outcome !== 'resumed') return outcome
            justResumed = true
            i--
            continue
          }
          if (e instanceof PolicyError) {
            return await fail(step.id, 'an action permitted by policy', e.reason, 'policy_denied')
          }
          if (e instanceof SurfaceTimeoutError) {
            // Bullet 2: the budget was pushed into Playwright's own timeout, so by
            // the time this is caught the action has actually stopped — there is
            // nothing still running to worry about, only a checkpoint that never
            // got a chance to hold.
            actionTimedOut = true
            cp = { ok: false, observed: `action ${step.action} did not complete within ${step.timeoutMs}ms: ${String(e)}` }
          } else {
            throw e
          }
        } finally {
          if (oneShot) {
            surface.setContext({ approvalState: capability.approval.state })
            approvedStep = null
          }
        }

        if (!actionTimedOut) {
          cp = await surface.checkpointHolds(step.checkpoint, resolveInput, { timeoutMs: remaining(deadline) })
        }

        while (!cp.ok && Date.now() < deadline) {
          const outcomeNow = await detectBusinessOutcome(surface, capability.businessOutcomes)
          if (outcomeNow) {
            const r: ReplayResult = { status: 'business_outcome', code: outcomeNow.code, message: outcomeNow.message ?? outcomeNow.code, evidence: rec.dir }
            await rec.event('replay.result', { result: r })
            await store.recordReplayAttempt(opts.ref, true, null)
            return r
          }
          const recovered = await applyRecovery(surface, step.onError, { entryPoint, deadline }, timeoutState)
          if (recovered.kind === 'not-applicable') break
          await rec.event(recovered.kind === 'recovered' ? 'step.recovered' : 'step.waited', { id: step.id, rung: recovered.rung })
          const budget = remaining(deadline)
          if (budget <= 0) break
          cp = await surface.checkpointHolds(step.checkpoint, resolveInput, { timeoutMs: budget })
        }

        if (!cp.ok) {
          // "Never got there in time" (step_timeout) is a different diagnosis from
          // "got somewhere wrong" (checkpoint_failed): the deadline is what decides
          // which one this run reports.
          const cls = Date.now() >= deadline ? 'step_timeout' : 'checkpoint_failed'
          return await fail(step.id, JSON.stringify(step.checkpoint), cp.observed, cls)
        }

        await rec.event('step.ok', { id: step.id })
      }

      const success = await surface.checkpointHolds(capability.successCondition, resolveInput)
      if (!success.ok) {
        return await fail('(successCondition)', JSON.stringify(capability.successCondition), success.observed, 'checkpoint_failed')
      }

      const r: ReplayResult = { status: 'success', outputs, evidence: rec.dir }
      await rec.event('replay.result', { result: { ...r, outputs: '[see run]' } })
      await store.recordReplayAttempt(opts.ref, true, null)
      return r
    } catch (e) {
      if (e instanceof PolicyError && e.verdict === 'HOLD') {
        // C4: this branch IS reachable, contrary to what this comment used to claim.
        // `applyRecovery`'s `dialog-present` rung calls `surface.act('dismiss', ...)`
        // outside the per-step try/catch above; `dismiss` classifies as `mutate`, so a
        // still-`draft` capability hitting the MOTD interstitial raises a HOLD here,
        // with no step index in scope to retry from.
        const outcome = await block('(surface)', e.reason)
        return outcome === 'resumed'
          ? await fail('(run)', 'the recorded flow to complete',
              'a human cleared the hold, but there is no step position to resume from here; re-run the capability',
              'surface_error')
          : outcome
      }
      // C2: a DENY is a refusal, not a browser malfunction — an off-allowlist
      // binding, an origin/path outside the policy, or acting without the lease all
      // raise PolicyError with verdict DENY from `open`, `resolve`, or
      // `checkpointHolds` (via `observe`), and land here uncaught by the per-step
      // try/catch, which only wraps `surface.act`.
      if (e instanceof PolicyError && e.verdict === 'DENY') {
        return await fail('(run)', 'an action permitted by policy', e.reason, 'policy_denied')
      }
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
    await note('replay.error', { error: msg })

    // F30: Classify setup errors: missing capability is input_invalid, others are surface_error.
    if (/capability not found/i.test(msg)) {
      const r: ReplayResult = {
        status: 'failed', step: '(capability)', expected: `capability ${opts.ref}`,
        observed: msg, class: 'input_invalid', evidence: rec.dir,
      }
      await note('replay.result', { result: r })
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
    await note('replay.result', { result: r })
    try {
      await store.recordReplayAttempt(opts.ref, false, 'setup_failed')
    } catch {
      // Capability may not exist yet; suppress error.
    }
    return r
  }
}
