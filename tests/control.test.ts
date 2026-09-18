import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LeaseStore } from '../src/control/lease.js'
import { InterventionStore } from '../src/control/interventions.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ctl-')) })

describe('LeaseStore', () => {
  it('grants a lease with an incrementing fencing token', async () => {
    const s = new LeaseStore(dir)
    const a = await s.acquire('sess1', 'agent')
    const b = await s.release('sess1', 'human:op-7')
    expect(b.token).toBe(a.token + 1)
    expect(b.holder).toBe('human:op-7')
  })

  it('recognises the current holder with the current token', async () => {
    const s = new LeaseStore(dir)
    const l = await s.acquire('sess1', 'agent')
    expect(await s.holds('sess1', 'agent', l.token)).toBe(true)
  })

  it('rejects a stale token even from the right holder', async () => {
    const s = new LeaseStore(dir)
    const l = await s.acquire('sess1', 'agent')
    await s.release('sess1', 'human:op-7')
    await s.release('sess1', 'agent')
    expect(await s.holds('sess1', 'agent', l.token)).toBe(false)
  })

  it('rejects the wrong holder holding the current token', async () => {
    const s = new LeaseStore(dir)
    const l = await s.acquire('sess1', 'agent')
    expect(await s.holds('sess1', 'human:op-7', l.token)).toBe(false)
  })

  it('refuses a handover from a caller holding a stale token', async () => {
    const s = new LeaseStore(dir)
    const first = await s.acquire('sess1', 'agent')
    await s.release('sess1', 'human:op-7', first.token)
    await expect(s.release('sess1', 'agent', first.token)).rejects.toThrow(/moved: expected token/)
  })
})

describe('InterventionStore', () => {
  it('raises and lists an open intervention', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({
      runId: 'r1', capability: 'k@1.0.0', step: 's3',
      reason: 'unknown_dialog', evidenceDir: 'store/runs/r1/evidence',
      redactedParams: { memberId: 'sha256:abc' },
    })
    expect(iv.id).toMatch(/^iv_/)
    expect((await s.list()).map((x) => x.id)).toContain(iv.id)
    expect((await s.get(iv.id)).state).toBe('open')
  })

  it('records what the human did on resolve', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({
      runId: 'r1', capability: 'k@1.0.0', step: 's3', reason: 'unknown_dialog',
      evidenceDir: 'd', redactedParams: {},
    })
    await s.resolve(iv.id, 'cleared the notice', [{ urlBefore: 'a', urlAfter: 'b', note: 'clicked Acknowledge' }])
    const got = await s.get(iv.id)
    expect(got.state).toBe('resolved')
    expect(got.note).toBe('cleared the notice')
    expect(got.humanActions?.[0]?.note).toBe('clicked Acknowledge')
  })

  it('never stores an unredacted parameter it was not given', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({
      runId: 'r1', capability: 'k@1.0.0', step: 's3', reason: 'r', evidenceDir: 'd',
      redactedParams: { memberId: 'sha256:abc123def456' },
    })
    expect(JSON.stringify(await s.get(iv.id))).not.toContain('40021')
  })

  it('never exposes a torn intervention file to a concurrent reader', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({ runId: 'r', capability: 'k@1.0.0', step: 's1', reason: 'r', evidenceDir: 'd', redactedParams: {} })
    let parseFailures = 0
    const writer = (async () => {
      for (let i = 0; i < 100; i++) await s.resolve(iv.id, `note ${i} ${'x'.repeat(2000)}`)
    })()
    const reader = (async () => {
      for (let i = 0; i < 300; i++) {
        try { await s.get(iv.id) } catch { parseFailures++ }
      }
    })()
    await Promise.all([writer, reader])
    expect(parseFailures).toBe(0)
  })
})
