import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../target-app/server.js'
import { WebSurface, PolicyError, SurfaceTimeoutError, type Resolution } from '../src/surface/web.js'
import type { PolicyConfig } from '../src/policy/allowlist.js'
import type { TargetDescriptor } from '../src/capability/schema.js'

const PORT = 4112
const base = `http://localhost:${PORT}`
const policy: PolicyConfig = {
  allowedOrigins: [base],
  allowedPathPrefixes: ['/', '/nav', '/member'],
  allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
}

let server: Server
let surface: WebSurface

beforeAll(async () => {
  server = createServer().listen(PORT)
  await new Promise((r) => server.once('listening', r))
  surface = new WebSurface(policy, true)
  await surface.start()
  surface.setContext({ approvalState: 'approved', leaseHeld: true })
})

afterAll(async () => {
  await surface.close()
  await new Promise((r) => server.close(() => r(undefined)))
})

describe('WebSurface against the hostile app', () => {
  it('finds the member number box by its adjacent label, with no id present', async () => {
    await surface.open(base + '/member/search')
    const r = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    expect(r.kind).toBe('one')
  })

  it('fills and clicks through to a balance', async () => {
    await surface.open(base + '/member/search')
    const box = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    if (box.kind !== 'one') throw new Error('box not resolved')
    await surface.act('fill', box.node, '40021')
    const btn = await surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })
    if (btn.kind !== 'one') throw new Error('button not resolved')
    await surface.act('click', btn.node)
    const cp = await surface.checkpointHolds({ kind: 'text-present', text: 'Share Balance' })
    expect(cp.ok).toBe(true)
  })

  it('fails a field-has-value checkpoint when the control is present but empty', async () => {
    await surface.open(base + '/member/search')
    const cp = { kind: 'field-has-value' as const, role: 'textbox', name: 'Member No.', framePath: [] }
    const empty = await surface.checkpointHolds(cp)
    expect(empty.ok).toBe(false)
    expect(empty.observed).toMatch(/empty/i)

    const box = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    if (box.kind !== 'one') throw new Error('box not resolved')
    await surface.act('fill', box.node, '40021')
    expect((await surface.checkpointHolds(cp)).ok).toBe(true)
  })

  it('fails field-value-matches-input when a stale value is already in the box', async () => {
    await surface.open(base + '/member/search')
    const box = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    if (box.kind !== 'one') throw new Error('box not resolved')
    // Simulate a previous invocation's leftover value: the box holds 40021, but
    // this invocation is for 40023.
    await surface.act('fill', box.node, '40021')
    const cp = { kind: 'field-value-matches-input' as const, role: 'textbox', name: 'Member No.', framePath: [], input: 'memberId' }
    const stale = await surface.checkpointHolds(cp, (name) => (name === 'memberId' ? '40023' : undefined))
    expect(stale.ok).toBe(false)
    expect(stale.observed).not.toContain('40021')
    expect(stale.observed).not.toContain('40023')
    expect(stale.observed).toMatch(/holds .* expected/)
  })

  it('passes field-value-matches-input when the live value matches the input', async () => {
    await surface.open(base + '/member/search')
    const box = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    if (box.kind !== 'one') throw new Error('box not resolved')
    await surface.act('fill', box.node, '40023')
    const cp = { kind: 'field-value-matches-input' as const, role: 'textbox', name: 'Member No.', framePath: [], input: 'memberId' }
    const ok = await surface.checkpointHolds(cp, (name) => (name === 'memberId' ? '40023' : undefined))
    expect(ok.ok).toBe(true)
  })

  it('distinguishes field-not-found and field-empty from a value mismatch', async () => {
    await surface.open(base + '/member/search')
    const missing = { kind: 'field-value-matches-input' as const, role: 'textbox', name: 'Does Not Exist', framePath: [], input: 'memberId' }
    const missingResult = await surface.checkpointHolds(missing, () => '40023')
    expect(missingResult.observed).toMatch(/not found/)

    const empty = { kind: 'field-value-matches-input' as const, role: 'textbox', name: 'Member No.', framePath: [], input: 'memberId' }
    const emptyResult = await surface.checkpointHolds(empty, () => '40023')
    expect(emptyResult.observed).toMatch(/empty/)
  })

  it('refuses to navigate outside the allowlist', async () => {
    await expect(surface.open('http://evil.test/')).rejects.toBeInstanceOf(PolicyError)
  })

  it('refuses to read or act when the lease is not held', async () => {
    await surface.open(base + '/member/search')
    surface.setContext({ leaseHeld: false })
    await expect(surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })).rejects.toBeInstanceOf(PolicyError)
    surface.setContext({ leaseHeld: true })
    const r = await surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })
    if (r.kind !== 'one') throw new Error('not resolved')
    surface.setContext({ leaseHeld: false })
    await expect(surface.act('click', r.node)).rejects.toBeInstanceOf(PolicyError)
    surface.setContext({ leaseHeld: true })
  })

  // F50: Playwright's own `timeout` option treats 0 as "no timeout at all," not
  // "already expired." A budget hitting exactly 0 is precisely what happens when a
  // step's clock has run out — the feature's own boundary case — so act()/open()
  // must catch it themselves before it ever reaches Playwright. A short test
  // timeout here means a regression (falling back to Playwright's real default,
  // tens of seconds) fails this test fast instead of stalling the whole suite.
  it('F50: act() with a budget of exactly 0 rejects with SurfaceTimeoutError instead of waiting forever', async () => {
    await surface.open(base + '/member/search')
    const btn = await surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })
    if (btn.kind !== 'one') throw new Error('button not resolved')
    await expect(surface.act('click', btn.node, undefined, { timeoutMs: 0 })).rejects.toBeInstanceOf(SurfaceTimeoutError)
  }, 2000)

  it('F50: open() with a budget of exactly 0 rejects with SurfaceTimeoutError instead of waiting forever', async () => {
    await expect(surface.open(base + '/member/search', { timeoutMs: 0 })).rejects.toBeInstanceOf(SurfaceTimeoutError)
  }, 2000)
})

// The frameset at "/" had never been driven before wave 3: every other test and
// demo enters /member/search directly, so framePath was always [] and frame
// support was built but unproven.
//
// A child <frame src="..."> hasn't necessarily finished loading its own document
// by the time the parent frameset's "domcontentloaded" fires, so a single
// surface.resolve() right after open() can race the "main" frame's own load. This
// is exactly the bounded "wait, then re-observe" pattern replay's own resolve
// loop (src/replay/execute.ts) already applies for the same reason — it just
// isn't available to a raw WebSurface test, so it's reproduced locally here.
async function resolveInFrame(s: WebSurface, target: TargetDescriptor, timeoutMs = 2000): Promise<Resolution> {
  const deadline = Date.now() + timeoutMs
  let r = await s.resolve(target)
  while (r.kind === 'none' && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 50))
    r = await s.resolve(target)
  }
  return r
}

describe('the frameset at /', () => {
  it('resolves the member number box inside the "main" child frame, not the top document', async () => {
    await surface.open(base + '/')
    const r = await resolveInFrame(surface, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r.kind).toBe('one')
    if (r.kind === 'one') expect(r.node.framePath).toEqual(['main'])
  })

  it('fills, clicks Inquire and reads the balance entirely inside "main" while the top-level URL stays at /', async () => {
    await surface.open(base + '/')
    const box = await resolveInFrame(surface, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    if (box.kind !== 'one') throw new Error('box not resolved')
    await surface.act('fill', box.node, '40021')
    const btn = await resolveInFrame(surface, { role: 'button', name: 'Inquire', framePath: ['main'], fallbacks: [] })
    if (btn.kind !== 'one') throw new Error('button not resolved')
    await surface.act('click', btn.node)
    const cp = await surface.checkpointHolds({ kind: 'text-present', text: 'Share Balance', framePath: ['main'] })
    expect(cp.ok).toBe(true)
    // F48's premise, proven directly: the top-level frameset document never
    // navigates — only the named "main" child frame does.
    expect(surface.url()).toBe(base + '/')
    expect(surface.frameUrl(['main'])).toContain('/member/inquire')
  })
})
