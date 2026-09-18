import { writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** Write to a unique temp file, then rename over the target. Within one volume a rename is
 *  atomic on POSIX and Windows, so a concurrent reader sees the old file or the new one —
 *  never a truncated one.
 *
 *  Windows refuses to rename onto a path while any handle (e.g. a reader's open fd) has that
 *  path open, throwing EPERM/EACCES/EBUSY — this is a normal, transient condition under
 *  concurrent access, not a real failure. A fixed retry count can't tell a brief stall from a
 *  starved writer, so instead we retry against a wall-clock deadline: keep trying for up to
 *  2 seconds, with exponential backoff (starting ~5ms, x1.5 growth, capped at 50ms, with jitter
 *  so competing writers don't retry in lockstep). Two seconds is generous enough to ride out
 *  realistic reader contention, but short enough that a genuinely starved writer fails loudly
 *  instead of hanging forever. On deadline expiry, or any non-retryable error, the temp file is
 *  cleaned up and the original error is rethrown so callers see the real cause. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, data, 'utf8')
  const deadline = Date.now() + 2000
  let backoff = 5
  for (;;) {
    try {
      await rename(tmp, path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (retryable && Date.now() < deadline) {
        const jitter = Math.random() * backoff * 0.5
        await new Promise((r) => setTimeout(r, backoff + jitter))
        backoff = Math.min(backoff * 1.5, 50)
        continue
      }
      await rm(tmp, { force: true })
      throw e
    }
  }
}
