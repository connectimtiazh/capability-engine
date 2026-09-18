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
    for (const f of await filesUnder('src')) {
      if (f.replace(/\\/g, '/').endsWith('src/surface/web.ts')) continue
      const src = await readFile(f, 'utf8')
      if (/from ['"]playwright['"]/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('replay never imports discovery or a model', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder(join('src', 'replay'))) {
      const src = await readFile(f, 'utf8')
      if (/from ['"].*\/discover\//.test(src) || /from ['"].*model\.js['"]/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('the compiler is the only module that reads a trace', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder('src')) {
      const norm = f.replace(/\\/g, '/')
      if (norm.endsWith('src/compile/compile.ts') || norm.startsWith('src/discover/') || norm.startsWith('src/cli/')) continue
      const src = await readFile(f, 'utf8')
      if (/\bTrace\b/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('no replay module can reach a model client, even transitively', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder(join('src', 'replay'))) {
      const src = await readFile(f, 'utf8')
      for (const m of src.matchAll(/from ['"]([^'"]+)['"]/g)) {
        const spec = m[1]!
        if (/discover|model|openrouter|anthropic|openai/i.test(spec)) offenders.push(`${f} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('ThrowingModel', () => {
  it('makes an accidental model call during replay loud rather than silent', async () => {
    const { ThrowingModel } = await import('../src/discover/model.js')
    await expect(new ThrowingModel().propose()).rejects.toThrow(/decision loop must be model-free/)
  })
})
