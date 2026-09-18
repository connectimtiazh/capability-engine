import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CapabilitySchema, BindingSchema, type Capability, type Binding } from './schema.js'

function splitRef(ref: string): { key: string; version: string } {
  const at = ref.lastIndexOf('@')
  if (at < 0) throw new Error(`malformed capability ref: ${ref}`)
  return { key: ref.slice(0, at), version: ref.slice(at + 1) }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Deep-merges override fragments over a base object. Arrays are replaced wholesale:
 *  a tenant that overrides a fallback ladder means to replace it, not to append to it. */
function mergeDeep<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base
  if (Array.isArray(over) || typeof over !== 'object') return over as T
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export class FileStore {
  constructor(private readonly root: string) {}

  private capPath(key: string, version: string): string {
    return join(this.root, 'capabilities', key, `${version}.json`)
  }
  private bindPath(tenant: string, key: string): string {
    return join(this.root, 'bindings', tenant, `${key.replace(/\//g, '__')}.json`)
  }

  async saveCapability(c: Capability): Promise<void> {
    const parsed = CapabilitySchema.parse(c)
    await writeJson(this.capPath(parsed.key, parsed.version), parsed)
  }

  async loadCapability(ref: string): Promise<Capability> {
    const { key, version } = splitRef(ref)
    const raw = await readJson<unknown>(this.capPath(key, version))
    if (!raw) throw new Error(`capability not found: ${ref}`)
    return CapabilitySchema.parse(raw)
  }

  async listCapabilities(): Promise<Capability[]> {
    const root = join(this.root, 'capabilities')
    const out: Capability[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith('.json')) {
          const raw = await readJson<unknown>(p)
          if (raw) out.push(CapabilitySchema.parse(raw))
        }
      }
    }
    await walk(root)
    return out
  }

  async saveBinding(b: Binding): Promise<void> {
    const parsed = BindingSchema.parse(b)
    const { key } = splitRef(parsed.capability.replace('@^', '@'))
    await writeJson(this.bindPath(parsed.tenant, key), parsed)
  }

  async loadBinding(tenant: string, key: string): Promise<Binding | null> {
    const raw = await readJson<unknown>(this.bindPath(tenant, key))
    return raw ? BindingSchema.parse(raw) : null
  }

  /** Binding override -> vendor capability. The ladder mirrors the version ladder
   *  the runtime kernel already uses for skills. */
  async resolveForTenant(ref: string, tenant: string): Promise<{ capability: Capability; binding: Binding | null }> {
    const capability = await this.loadCapability(ref)
    const binding = await this.loadBinding(tenant, capability.key)
    if (!binding?.overrides?.steps) return { capability, binding }

    const steps = capability.steps.map((s) => {
      const over = binding.overrides.steps?.[s.id]
      return over ? mergeDeep(s, over) : s
    })
    return { capability: { ...capability, steps }, binding }
  }

  async recordDrift(tenant: string, key: string, step: string, resolvedVia: string): Promise<void> {
    const b = await this.loadBinding(tenant, key)
    if (!b) return
    const existing = b.driftLog.find((d) => d.step === step && d.resolvedVia === resolvedVia)
    if (existing) existing.count += 1
    else b.driftLog.push({ step, resolvedVia, count: 1, since: new Date().toISOString() })
    await this.saveBinding(b)
  }

  async recordReplayAttempt(ref: string, ok: boolean, failure: string | null): Promise<void> {
    const c = await this.loadCapability(ref)
    c.approval.replayStats.attempts += 1
    if (ok) c.approval.replayStats.successes += 1
    // `null` means "no new failure to record" — a blocked run counts as an attempt but must not
    // erase the last real failure, which is what a reviewer reads when deciding on autonomy.
    else if (failure !== null) c.approval.replayStats.lastFailure = failure
    await this.saveCapability(c)
  }
}
