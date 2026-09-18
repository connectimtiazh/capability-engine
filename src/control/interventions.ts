import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface HumanAction {
  urlBefore: string
  urlAfter: string
  note: string
}

export interface Intervention {
  id: string
  runId: string
  capability: string
  step: string
  reason: string
  evidenceDir: string
  redactedParams: Record<string, unknown>
  state: 'open' | 'resolved'
  raisedAt: string
  note?: string
  humanActions?: HumanAction[]
}

export class InterventionStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, 'interventions')
  }
  private path(id: string): string {
    return join(this.dir(), `${id}.json`)
  }

  async raise(i: Omit<Intervention, 'id' | 'state' | 'raisedAt'>): Promise<Intervention> {
    const iv: Intervention = { ...i, id: `iv_${randomUUID().slice(0, 6)}`, state: 'open', raisedAt: new Date().toISOString() }
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.path(iv.id), JSON.stringify(iv, null, 2) + '\n', 'utf8')
    return iv
  }

  async get(id: string): Promise<Intervention> {
    return JSON.parse(await readFile(this.path(id), 'utf8')) as Intervention
  }

  async list(): Promise<Intervention[]> {
    try {
      const names = await readdir(this.dir())
      return await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.replace('.json', ''))))
    } catch {
      return []
    }
  }

  async resolve(id: string, note: string, humanActions: HumanAction[] = []): Promise<Intervention> {
    const iv = await this.get(id)
    const next: Intervention = { ...iv, state: 'resolved', note, humanActions }
    await writeFile(this.path(id), JSON.stringify(next, null, 2) + '\n', 'utf8')
    return next
  }
}
