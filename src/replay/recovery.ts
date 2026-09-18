import type { RecoveryRung } from '../capability/schema.js'
import type { WebSurface } from '../surface/web.js'

export type RecoveryResult = 'recovered' | 'not-applicable'

/** The three piles, sorted at authoring time rather than at run time.
 *
 *  Recovery is declared on the step, so the system is never deciding *how* to
 *  recover while it runs — it is executing a recovery someone reviewed. */
export async function applyRecovery(
  surface: WebSurface,
  rungs: RecoveryRung[],
  ctx: { entryPoint: string },
): Promise<RecoveryResult> {
  // Ruling F3: the generic `timeout` rung returns `recovered` unconditionally (it
  // does not check anything, it just waits), so it must never be tried before a
  // specific detector that can actually tell whether its recovery applies.
  const ordered = [...rungs.filter((r) => r.when !== 'timeout'), ...rungs.filter((r) => r.when === 'timeout')]
  for (const rung of ordered) {
    if (rung.when === 'dialog-present') {
      const hit = await surface.checkpointHolds({ kind: 'text-present', text: rung.match })
      if (!hit.ok) continue
      const btn = await surface.resolve({ role: 'button', name: 'Acknowledge', framePath: [], fallbacks: [] })
      if (btn.kind === 'one') {
        await surface.act('dismiss', btn.node)
        return 'recovered'
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
      return 'recovered'
    }

    if (rung.when === 'timeout') {
      await new Promise((r) => setTimeout(r, rung.backoffMs))
      return 'recovered'
    }
  }
  return 'not-applicable'
}
