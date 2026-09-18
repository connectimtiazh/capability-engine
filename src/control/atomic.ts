import { writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** Write to a unique temp file, then rename over the target. Within one volume a rename is
 *  atomic on POSIX and Windows, so a concurrent reader sees the old file or the new one —
 *  never a truncated one. Windows can refuse the rename while a reader holds the target open,
 *  so a few short retries cover that window. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, data, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
        continue
      }
      await rm(tmp, { force: true })
      throw e
    }
  }
}
