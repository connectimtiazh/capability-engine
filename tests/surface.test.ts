import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../target-app/server.js'
import { WebSurface, PolicyError } from '../src/surface/web.js'
import type { PolicyConfig } from '../src/policy/allowlist.js'

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

  it('refuses to navigate outside the allowlist', async () => {
    await expect(surface.open('http://evil.test/')).rejects.toBeInstanceOf(PolicyError)
  })

  it('refuses to act at all when the lease is not held', async () => {
    await surface.open(base + '/member/search')
    surface.setContext({ leaseHeld: false })
    const r = await surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })
    if (r.kind !== 'one') throw new Error('not resolved')
    await expect(surface.act('click', r.node)).rejects.toBeInstanceOf(PolicyError)
    surface.setContext({ leaseHeld: true })
  })
})
