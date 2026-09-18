import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export class Recorder {
  readonly dir: string
  private readonly timeline: string

  constructor(storeRoot: string, readonly runId: string) {
    this.dir = join(storeRoot, 'runs', runId)
    this.timeline = join(this.dir, 'timeline.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'evidence'), { recursive: true })
  }

  /** Append-only. A crash mid-run leaves a readable file rather than a corrupt one,
   *  and this single file is simultaneously the debug log, the audit trail and the
   *  evidence artifact. */
  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    await appendFile(this.timeline, JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n', 'utf8')
  }

  evidencePath(label: string, ext: string): string {
    return join(this.dir, 'evidence', `${label}.${ext}`)
  }

  async shot(surface: { screenshot(p: string): Promise<void> }, label: string): Promise<string> {
    const p = this.evidencePath(label, 'png')
    await surface.screenshot(p)
    return p
  }

  async dom(surface: { domSnapshot(p: string): Promise<void> }, label: string): Promise<string> {
    const p = this.evidencePath(label, 'html')
    await surface.domSnapshot(p)
    return p
  }
}
