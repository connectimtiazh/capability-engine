import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../target-app/server.js'
import { FileStore } from '../src/capability/store.js'
import { compile } from '../src/compile/compile.js'
import { replay } from '../src/replay/execute.js'
import type { Trace } from '../src/discover/loop.js'
import type { PolicyConfig } from '../src/policy/allowlist.js'

const PORT = 4114
const base = `http://localhost:${PORT}`
const policy: PolicyConfig = {
  allowedOrigins: [base],
  allowedPathPrefixes: ['/', '/nav', '/member'],
  allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
}

const trace = (): Trace => ({
  goal: 'look up a member savings balance', runId: 'disc_test',
  entryPoint: base + '/member/search', model: 'test-model',
  steps: [
    { intent: 'Type the member number', action: 'fill', resolvedVia: 'primary', value: '40021',
      target: { role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] },
      urlAfter: base + '/member/search', textAfter: 'Member No.' },
    { intent: 'Submit the inquiry', action: 'click', resolvedVia: 'primary',
      target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
      urlAfter: base + '/member/inquire', textAfter: 'Member A. Whitfield (40021)\nShare Balance\n1284.55' },
  ],
  extracted: {
    savingsBalance: {
      value: 'Share Balance 1284.55', as: 'number',
      from: {
        role: 'table', name: '', framePath: [], fallbacks: [],
        anchor: { kind: 'table-cell', rowHeader: 'Share Balance', offset: { col: 1 } },
      },
    },
  },
  observedOutcomes: [], finalText: 'Member A. Whitfield (40021)\nShare Balance\n1284.55',
})

let server: Server
let dir: string
const REF = 'quest-core/member.savings_balance@1.0.0'

beforeAll(async () => {
  server = createServer().listen(PORT)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'replay-'))
  const store = new FileStore(dir)
  const cap = compile(trace(), { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
  // Approved, because these tests exercise replay rather than the approval gate.
  await store.saveCapability({ ...cap, approval: { ...cap.approval, state: 'approved' } })
  await store.saveBinding({
    tenant: 'firstvalley-cu', capability: REF, entryPoint: base + '/member/search',
    overrides: {}, driftLog: [],
  })
})

const run = (params: Record<string, unknown>, entry?: string) =>
  replay({ ref: REF, tenant: 'firstvalley-cu', params, storeRoot: dir, headless: true, policyOverride: policy, entryPointOverride: entry })

describe('replay', () => {
  it('succeeds and returns the declared output for a known member', async () => {
    const r = await run({ memberId: '40021' })
    expect(r.status).toBe('success')
    if (r.status === 'success') expect(r.outputs.savingsBalance).toBe(1284.55)
  }, 60_000)

  it('replays a member other than the one recorded, returning their own balance', async () => {
    const r = await run({ memberId: '40023' })
    expect(r.status).toBe('success')
    if (r.status === 'success') expect(r.outputs.savingsBalance).toBe(312)
  }, 60_000)

  it('returns a business outcome, not a failure, for an unknown member', async () => {
    const r = await run({ memberId: '99999' })
    expect(r.status).toBe('business_outcome')
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_NOT_FOUND')
  }, 60_000)

  it('returns a distinct business outcome for a restricted member', async () => {
    const r = await run({ memberId: '40022' })
    expect(r.status).toBe('business_outcome')
    if (r.status === 'business_outcome') expect(r.code).toBe('ACCOUNT_RESTRICTED')
  }, 60_000)

  it('fails with input_invalid before touching the surface when params break the schema', async () => {
    const r = await run({ memberId: 'not-a-number' })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.class).toBe('input_invalid')
  }, 60_000)

  it('recovers from an injected session timeout and still completes', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=session-timeout')
    expect(r.status).toBe('success')
  }, 60_000)

  it('recovers from a known interstitial without surfacing it', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=motd')
    expect(r.status).toBe('success')
  }, 60_000)

  it('blocks on an unrecognised dialog rather than guessing', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=unknown-dialog')
    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.interventionId).toMatch(/^iv_/)
  }, 60_000)

  it('keeps the member number out of replay evidence on disk', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=unknown-dialog')
    expect(r.status).toBe('blocked')
    const { readFile, readdir } = await import('node:fs/promises')
    const dir = r.evidence
    const timeline = await readFile(join(dir, 'timeline.jsonl'), 'utf8')
    expect(timeline).not.toContain('40021')
    for (const f of await readdir(join(dir, 'evidence'))) {
      if (f.endsWith('.html')) expect(await readFile(join(dir, 'evidence', f), 'utf8')).not.toContain('40021')
    }
  }, 60_000)

  it('accumulates replay stats on the capability', async () => {
    await run({ memberId: '40021' })
    const c = await new FileStore(dir).loadCapability(REF)
    expect(c.approval.replayStats.attempts).toBe(1)
    expect(c.approval.replayStats.successes).toBe(1)
  }, 60_000)

  it('holds rather than acts when the capability is still a draft', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    await store.saveCapability({ ...c, approval: { ...c.approval, state: 'draft' } })
    const r = await run({ memberId: '40021' })
    expect(r.status).toBe('blocked')
  }, 60_000)
})
