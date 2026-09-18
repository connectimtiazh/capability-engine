import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder } from '../src/evidence/recorder.js'

describe('Recorder evidence redaction', () => {
  it('scrubs declared values out of a DOM snapshot on disk', async () => {
    const rec = new Recorder(await mkdtemp(join(tmpdir(), 'rec-')), 'run1')
    await rec.init()
    rec.setRedactions(['40021'])
    const p = await rec.dom({ domSnapshot: (path: string) => writeFile(path, '<td>A. Whitfield (40021)</td>') }, 'x')
    const html = await readFile(p, 'utf8')
    expect(html).not.toContain('40021')
    expect(html).toContain('[redacted]')
  })

  it('asks the surface to mask inputs and declared values when redacting', async () => {
    const rec = new Recorder(await mkdtemp(join(tmpdir(), 'rec-')), 'run2')
    await rec.init()
    rec.setRedactions(['40021'])
    let seen: unknown[] = []
    await rec.shot({ screenshot: async (...args: unknown[]) => { seen = args } }, 'x')
    expect(seen[1]).toEqual(['input[type="text"]', 'input:not([type])'])
    expect(seen[2]).toEqual(['40021'])
  })

  it('takes a plain screenshot when nothing is declared sensitive', async () => {
    const rec = new Recorder(await mkdtemp(join(tmpdir(), 'rec-')), 'run3')
    await rec.init()
    let seen: unknown[] = []
    await rec.shot({ screenshot: async (...args: unknown[]) => { seen = args } }, 'x')
    expect(seen).toHaveLength(1)
  })
})
