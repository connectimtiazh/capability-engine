import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
 *  current, and a stale token is refused, so exactly one party can act at a time. */
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
    await writeFile(this.path(l.sessionId), JSON.stringify(l, null, 2) + '\n', 'utf8')
    return l
  }

  async acquire(sessionId: string, holder: string): Promise<Lease> {
    const cur = await this.current(sessionId)
    return this.write({ sessionId, holder, token: (cur?.token ?? 0) + 1, acquiredAt: new Date().toISOString() })
  }

  async release(sessionId: string, to: string): Promise<Lease> {
    return this.acquire(sessionId, to)
  }

  async holds(sessionId: string, holder: string, token: number): Promise<boolean> {
    const cur = await this.current(sessionId)
    return !!cur && cur.holder === holder && cur.token === token
  }
}
