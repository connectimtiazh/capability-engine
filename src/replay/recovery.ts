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

/** The three piles, sorted at authoring time rather than at run time.
 *
 *  Recovery is declared on the step, so the system is never deciding *how* to
 *  recover while it runs — it is executing a recovery someone reviewed. */
export async function applyRecovery(
  surface: WebSurface,
  rungs: RecoveryRung[],
  ctx: { entryPoint: string },
): Promise<RecoveryResult> {
  // Ruling F3: the generic `timeout` rung waits unconditionally (it does not check
  // anything), so it must never be tried before a specific detector that can
  // actually tell whether its recovery applies.
  const ordered = [...rungs.filter((r) => r.when !== 'timeout'), ...rungs.filter((r) => r.when === 'timeout')]
  for (const rung of ordered) {
    if (rung.when === 'dialog-present') {
      const hit = await surface.checkpointHolds({ kind: 'text-present', text: rung.match })
      if (!hit.ok) continue
      const btn = await surface.resolve({ role: 'button', name: 'Acknowledge', framePath: [], fallbacks: [] })
      if (btn.kind === 'one') {
        await surface.act('dismiss', btn.node)
        return { kind: 'recovered', rung: 'dialog-present' }
      }
    }

    if (rung.when === 'session-expired') {
      const expired = await surface.checkpointHolds({ kind: 'text-present', text: 'Your session has expired' })
      if (!expired.ok) continue
      // Do what an operator does: use the screen's own way back in. Re-navigating is the
      // fallback, with the query stripped so it cannot replay whatever caused the expiry.
      const reentry = await surface.resolve({ role: 'button', name: 'Sign in again', framePath: [], fallbacks: [] })
      if (reentry.kind === 'one') {
        await surface.act('dismiss', reentry.node)
      } else {
        const u = new URL(ctx.entryPoint)
        await surface.open(u.origin + u.pathname)
      }
      return { kind: 'recovered', rung: 'session-expired' }
    }

    if (rung.when === 'timeout') {
      await new Promise((r) => setTimeout(r, rung.backoffMs))
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
