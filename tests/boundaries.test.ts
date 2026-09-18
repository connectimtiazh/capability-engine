import { describe, it, expect } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (p.endsWith('.ts')) out.push(p)
    }
  }
  await walk(dir)
  return out
}

describe('architectural boundaries', () => {
  it('no module outside src/surface/web.ts imports playwright', async () => {
    const offenders: string[] = []
    const webPath = join('src', 'surface', 'web.ts')
    for (const f of await filesUnder('src')) {
      if (f.replace(/\\/g, '/') === webPath.replace(/\\/g, '/')) continue
      const src = await readFile(f, 'utf8')
      if (/from ['"]playwright['"]/.test(src)) offenders.push(f)
    }
    expect(offenders, [
      'Only src/surface/web.ts may import playwright.',
      'The replay engine cannot depend on any browser automation.',
      ...offenders,
    ].join('\n')).toEqual([])
  })

  it('replay never imports discovery or a model', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder(join('src', 'replay'))) {
      const src = await readFile(f, 'utf8')
      if (/from ['"].*\/discover\//.test(src) || /from ['"].*model\.js['"]/.test(src)) offenders.push(f)
    }
    expect(offenders, [
      'Replay modules must not import from discover or model.',
      'The replay engine runs without any LLM in the decision loop.',
      `Offending imports: ${offenders.join(', ') || 'none'}`,
    ].join('\n')).toEqual([])
  })

  it('the compiler is the only module that reads a trace', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder('src')) {
      const norm = f.replace(/\\/g, '/')
      if (norm.endsWith('src/compile/compile.ts') || norm.startsWith('src/discover/') || norm.startsWith('src/cli/')) continue
      const src = await readFile(f, 'utf8')
      if (/\bTrace\b/.test(src)) offenders.push(f)
    }
    expect(offenders, [
      'Only the compiler (src/compile), discovery (src/discover), and CLI (src/cli) may reference the Trace type.',
      'Trace is the compile-time decision history; runtime modules must not see it.',
      `Found in: ${offenders.join(', ') || 'none'}`,
    ].join('\n')).toEqual([])
  })

  it('no replay module can reach a model client, even transitively', async () => {
    const SUSPECT = /(^|[/@._-])(discover|discovery|model|models|openrouter|anthropic|openai)([/._-]|$)/i
    const offenders: string[] = []
    for (const f of await filesUnder(join('src', 'replay'))) {
      const src = await readFile(f, 'utf8')
      for (const m of src.matchAll(/from ['"]([^'"]+)['"]/g)) {
        const spec = m[1]!
        if (SUSPECT.test(spec)) offenders.push(`${f} -> ${spec}`)
      }
    }
    expect(offenders, [
      'A module under src/replay imported something model-shaped.',
      'Replay must be reachable without any model: that is the project\'s core claim.',
      'If this is a false positive, rename the module rather than widening this pattern.',
      ...offenders,
    ].join('\n')).toEqual([])
  })
})

describe('ThrowingModel', () => {
  it('makes an accidental model call during replay loud rather than silent', async () => {
    const { ThrowingModel } = await import('../src/discover/model.js')
    await expect(
      new ThrowingModel().propose(),
      'ThrowingModel must reject any propose() call: replay must never reach the model client.'
    ).rejects.toThrow(/decision loop must be model-free/)
  })
})
