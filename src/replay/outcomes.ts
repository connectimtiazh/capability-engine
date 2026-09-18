import type { BusinessOutcome, Checkpoint } from '../capability/schema.js'

export interface CheckpointCapable {
  checkpointHolds(c: Checkpoint): Promise<{ ok: boolean; observed: string }>
}

/** Detectors are matched, never interpreted.
 *
 *  An earlier generation of this idea sent the result to a model and asked what it
 *  meant. That is the thing replay must not do: the model authored these detectors
 *  at compile time, and at run time they are deterministic pattern matches. */
export async function detectBusinessOutcome(
  surface: CheckpointCapable,
  outcomes: BusinessOutcome[],
): Promise<BusinessOutcome | null> {
  for (const o of outcomes) {
    const { ok } = await surface.checkpointHolds(o.detect)
    if (ok) return o
  }
  return null
}
