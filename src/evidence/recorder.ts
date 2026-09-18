import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The one scrub implementation, shared by every writer of evidence to disk — the
 *  timeline (via Recorder.scrub), and anything else (like a discovery trace) that is
 *  serialised and written outside the Recorder's own append-only log. */
export function scrubText(text: string, redactions: string[]): string {
  let out = text
  for (const v of redactions.filter((r) => r.length >= 3)) out = out.split(v).join('[redacted]')
  return out
}

export class Recorder {
  readonly dir: string
  private readonly timeline: string
  private redactions: string[] = []

  constructor(storeRoot: string, readonly runId: string) {
    this.dir = join(storeRoot, 'runs', runId)
    this.timeline = join(this.dir, 'timeline.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'evidence'), { recursive: true })
  }

  /** Literal values to scrub from every line before it is written. Supplied by the
   *  caller because at discovery time no input schema exists yet — these are declared
   *  by the operator, not guessed from the text. */
  setRedactions(values: string[]): void {
    this.redactions = values.filter((v) => v.length >= 3)
  }

  private scrub(line: string): string {
    return scrubText(line, this.redactions)
  }

  /** Append-only. A crash mid-run leaves a readable file rather than a corrupt one,
   *  and this single file is simultaneously the debug log, the audit trail and the
   *  evidence artifact. */
  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...data })
    await appendFile(this.timeline, this.scrub(line) + '\n', 'utf8')
  }

  evidencePath(label: string, ext: string): string {
    return join(this.dir, 'evidence', `${label}.${ext}`)
  }

  async shot(
    surface: { screenshot(p: string, mask?: string[], maskText?: string[]): Promise<void> },
    label: string,
  ): Promise<string> {
    const p = this.evidencePath(label, 'png')
    if (this.redactions.length) {
      await surface.screenshot(p, ['input[type="text"]', 'input:not([type])'], this.redactions)
    } else {
      await surface.screenshot(p)
    }
    return p
  }

  async dom(surface: { domSnapshot(p: string): Promise<void> }, label: string): Promise<string> {
    const p = this.evidencePath(label, 'html')
    await surface.domSnapshot(p)
    const html = await readFile(p, 'utf8')
    await writeFile(p, this.scrub(html), 'utf8')
    return p
  }
}
