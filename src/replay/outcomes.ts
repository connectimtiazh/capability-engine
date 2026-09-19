import type { BusinessOutcome, Checkpoint } from '../capability/schema.js'

export interface CheckpointCapable {
  checkpointHolds(c: Checkpoint): Promise<{ ok: boolean; observed: string }>
  url(): string
  /** F48: a frame's own URL. Needed because inside a frameset the top-level URL
   *  (url()) never changes while an inner frame navigates — route scoping has to
   *  ask the frame the outcome was authored against, not the page. */
  frameUrl(framePath: string[]): string
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** Detectors are matched, never interpreted.
 *
 *  An earlier generation of this idea sent the result to a model and asked what it
 *  meant. That is the thing replay must not do: the model authored these detectors
 *  at compile time, and at run time they are deterministic pattern matches.
 *
 *  An outcome authored for one screen must never fire on another: text like "No
 *  record found" could appear anywhere in the app, and a detector that ignores
 *  where it was recorded would attribute an unrelated page's text to this
 *  operation's result. `when.route`/`when.framePath` scope the match to the
 *  screen the outcome was actually authored against. */
export async function detectBusinessOutcome(
  surface: CheckpointCapable,
  outcomes: BusinessOutcome[],
): Promise<BusinessOutcome | null> {
  for (const o of outcomes) {
    // F48: compare a route-scoped outcome against the pathname of the frame it
    // declares (when.framePath), never the top-level page — inside a frameset the
    // top URL stays put while the named child frame is the one that actually
    // navigates. Fall back to the top-level URL only when the outcome declares no
    // framePath at all, which is exactly the case for a capability recorded
    // against a direct, unframed entry point.
    const routeFramePath = o.when?.framePath
    const pathname = pathnameOf(
      routeFramePath && routeFramePath.length > 0 ? surface.frameUrl(routeFramePath) : surface.url(),
    )
    if (o.when?.route && o.when.route !== pathname) continue
    if (o.when?.framePath) {
      const detectFramePath = 'framePath' in o.detect ? (o.detect.framePath ?? []) : []
      if (JSON.stringify(detectFramePath) !== JSON.stringify(o.when.framePath)) continue
    }
    const { ok } = await surface.checkpointHolds(o.detect)
    if (ok) return o
  }
  return null
}
