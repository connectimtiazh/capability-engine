import type { RecoveryRung } from '../capability/schema.js'
import type { WebSurface } from '../surface/web.js'

/** `rung` names which onError entry actually fired, so the caller can log the truth
 *  instead of a blanket "recovered". The bare `timeout` rung does not check anything
 *  and does not fix anything — it only waits — so it must never be reported the same
 *  way as `dialog-present` or `session-expired` actually clearing an obstruction. */
export type RecoveryResult =
  | { kind: 'recovered'; rung: 'dialog-present' | 'session-expired' }
  | { kind: 'waited'; rung: 'timeout' }
  | { kind: 'not-applicable' }

/** Counts how many times the `timeout` rung has already fired for one step, so its
 *  declared `max` can be enforced across repeated calls to `applyRecovery` for that
 *  same step (mutated in place; the caller owns one instance per step). */
export interface TimeoutRungState {
  count: number
}

/** The three piles, sorted at authoring time rather than at run time.
 *
 *  Recovery is declared on the step, so the system is never deciding *how* to
 *  recover while it runs — it is executing a recovery someone reviewed.
 *
 *  `ctx.deadline`, when given, is the absolute Date.now() the calling step's
 *  budget runs out at. Every surface call this function makes is bounded by
 *  whatever remains of it, and once it has already passed, this function does
 *  nothing at all — including the timeout rung's own wait, which would otherwise
 *  sleep past a step the caller has already decided is out of time. */
export async function applyRecovery(
  surface: WebSurface,
  rungs: RecoveryRung[],
  ctx: { entryPoint: string; deadline?: number },
  timeoutState: TimeoutRungState = { count: 0 },
): Promise<RecoveryResult> {
  if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) {
    return { kind: 'not-applicable' }
  }
  const remaining = (): number | undefined =>
    ctx.deadline !== undefined ? Math.max(0, ctx.deadline - Date.now()) : undefined

  // Ruling F3: the generic `timeout` rung waits unconditionally (it does not check
  // anything), so it must never be tried before a specific detector that can
  // actually tell whether its recovery applies.
  const ordered = [...rungs.filter((r) => r.when !== 'timeout'), ...rungs.filter((r) => r.when === 'timeout')]
  for (const rung of ordered) {
    if (rung.when === 'dialog-present') {
      const hit = await surface.checkpointHolds({ kind: 'text-present', text: rung.match }, undefined, { timeoutMs: remaining() })
      if (!hit.ok) continue
      const btn = await surface.resolve({ role: 'button', name: 'Acknowledge', framePath: [], fallbacks: [] }, { timeoutMs: remaining() })
      if (btn.kind === 'one') {
        await surface.act('dismiss', btn.node, undefined, { timeoutMs: remaining() })
        return { kind: 'recovered', rung: 'dialog-present' }
      }
    }

    if (rung.when === 'session-expired') {
      const expired = await surface.checkpointHolds({ kind: 'text-present', text: 'Your session has expired' }, undefined, { timeoutMs: remaining() })
      if (!expired.ok) continue
      // Do what an operator does: use the screen's own way back in. Re-navigating is the
      // fallback, with the query stripped so it cannot replay whatever caused the expiry.
      const reentry = await surface.resolve({ role: 'button', name: 'Sign in again', framePath: [], fallbacks: [] }, { timeoutMs: remaining() })
      if (reentry.kind === 'one') {
        await surface.act('dismiss', reentry.node, undefined, { timeoutMs: remaining() })
      } else {
        const u = new URL(ctx.entryPoint)
        await surface.open(u.origin + u.pathname)
      }
      return { kind: 'recovered', rung: 'session-expired' }
    }

    if (rung.when === 'timeout') {
      // The defect this closes: `max` was declared on every capability's onError
      // ladder but nothing ever read it, so this rung waited unconditionally no
      // matter how many times it fired. Once `max` attempts are spent, treat the
      // rung as exhausted rather than applicable — the caller then has to decide
      // between another recovery path or reporting the step as failed.
      if (timeoutState.count >= rung.max) continue
      timeoutState.count++
      const budget = remaining()
      const wait = budget !== undefined ? Math.min(rung.backoffMs, budget) : rung.backoffMs
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      // Nothing was detected and nothing was fixed — this rung only waited. It is
      // reported distinctly from `recovered` so the timeline never claims a recovery
      // that did not happen. evidence/rep_5ecd18a5 shows the old bug (a false
      // `step.recovered` for this exact rung, on a block that no recovery could
      // clear); evidence/rep_d78bee66 is the same demo re-run under this fix,
      // logging `step.waited` instead.
      return { kind: 'waited', rung: 'timeout' }
    }
  }
  return { kind: 'not-applicable' }
}
