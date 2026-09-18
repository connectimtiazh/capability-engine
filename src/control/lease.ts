import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.js'

export interface Lease {
  sessionId: string
  holder: string
  token: number
  acquiredAt: string
}

/** A fencing token, not just a holder name.
 *
 *  Without it, "pause and resume" is a naming convention: a late write from the
 *  previous holder still lands. Every action carries the token it believes is
 *  current, and a stale token is refused, so exactly one party can act at a time.
 *
 *  Design: exactly ONE lease writer — the replay engine. The operator CLI never
 *  touches the lease; it resolves the intervention and the engine reacts. With a
 *  single writer the read-check-rename window cannot be raced; a second lease
 *  writer would need a lock file. */
export class LeaseStore {
  constructor(private readonly root: string) {}

  private path(sessionId: string): string {
    return join(this.root, 'control', `${sessionId}.lease.json`)
  }

  async current(sessionId: string): Promise<Lease | null> {
    try {
      return JSON.parse(await readFile(this.path(sessionId), 'utf8')) as Lease
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  private async write(l: Lease): Promise<Lease> {
    await mkdir(join(this.root, 'control'), { recursive: true })
    await writeFileAtomic(this.path(l.sessionId), JSON.stringify(l, null, 2) + '\n')
    return l
  }

  async acquire(sessionId: string, holder: string, expectedToken?: number): Promise<Lease> {
    const cur = await this.current(sessionId)
    const found = cur?.token ?? 0
    if (expectedToken !== undefined && found !== expectedToken) {
      throw new Error(`lease for ${sessionId} moved: expected token ${expectedToken}, found ${found}`)
    }
    return this.write({ sessionId, holder, token: found + 1, acquiredAt: new Date().toISOString() })
  }

  async release(sessionId: string, to: string, expectedToken?: number): Promise<Lease> {
    return this.acquire(sessionId, to, expectedToken)
  }

  async holds(sessionId: string, holder: string, token: number): Promise<boolean> {
    const cur = await this.current(sessionId)
    return !!cur && cur.holder === holder && cur.token === token
  }
}
