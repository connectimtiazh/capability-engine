import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createServer } from '../target-app/server.js'
import { FileStore } from '../src/capability/store.js'
import { compile } from '../src/compile/compile.js'
import { replay } from '../src/replay/execute.js'
import { InterventionStore } from '../src/control/interventions.js'
import { LeaseStore } from '../src/control/lease.js'
import { WebSurface, PolicyError } from '../src/surface/web.js'
import type { Trace } from '../src/discover/loop.js'
import type { PolicyConfig } from '../src/policy/allowlist.js'

// Task 9c models its setup on tests/replay.test.ts, but picks its own port at
// listen-time (0 == "give me a free one") rather than a hardcoded number, since
// this file runs alongside 4111-4114 already claimed by the other suites.
let server: Server
let base: string
let policy: PolicyConfig

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

let dir: string
const REF = 'quest-core/member.savings_balance@1.0.0'

beforeAll(async () => {
  server = createServer().listen(0)
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  base = `http://localhost:${port}`
  policy = {
    allowedOrigins: [base],
    allowedPathPrefixes: ['/', '/nav', '/member'],
    allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
  }
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'handoff-'))
  const store = new FileStore(dir)
  const cap = compile(trace(), { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
  // Approved by default; the draft-capability test flips this back per-test.
  await store.saveCapability({ ...cap, approval: { ...cap.approval, state: 'approved' } })
  await store.saveBinding({
    tenant: 'firstvalley-cu', capability: REF, entryPoint: base + '/member/search',
    overrides: {}, driftLog: [],
  })
})

describe('human handoff', () => {
  it('a human clears an obstruction through the live session and the run completes', async () => {
    const interventions = new InterventionStore(dir)
    let capturedId = ''

    const r = await replay({
      ref: REF, tenant: 'firstvalley-cu', params: { memberId: '40021' }, storeRoot: dir,
      headless: true, policyOverride: policy,
      entryPointOverride: base + '/member/search?inject=unknown-dialog',
      waitForHuman: true,
      onIntervention: async (iv, operator) => {
        capturedId = iv.id
        await operator.click('Acknowledge')
        await interventions.resolve(iv.id, 'cleared the compliance notice')
      },
    })

    expect(r.status).toBe('success')

    const resolved = await interventions.get(capturedId)
    expect(resolved.state).toBe('resolved')
    expect(resolved.humanActions?.[0]?.urlBefore).toBeTruthy()
    expect(resolved.humanActions?.[0]?.urlAfter).toBeTruthy()
    // The operator's note survives the engine's own resolve() call.
    expect(resolved.note).toBe('cleared the compliance notice')

    const timeline = await readFile(join(r.evidence, 'timeline.jsonl'), 'utf8')
    expect(timeline).toContain('control.handoff')
    expect(timeline).toContain('control.handback')

    // agent(1) -> human(2) -> agent(3)
    const runId = basename(r.evidence)
    const lease = await new LeaseStore(dir).current(`sess_${runId}`)
    expect(lease?.token).toBe(3)
    expect(lease?.holder).toBe('agent')
  }, 60_000)

  it('records one attempt for one invocation, however many pauses it took', async () => {
    // A run that pauses, gets help, and succeeds is one successful attempt — not
    // three. Same setup as the first test: it blocks once, the operator clears it,
    // and the run succeeds.
    const interventions = new InterventionStore(dir)

    const r = await replay({
      ref: REF, tenant: 'firstvalley-cu', params: { memberId: '40021' }, storeRoot: dir,
      headless: true, policyOverride: policy,
      entryPointOverride: base + '/member/search?inject=unknown-dialog',
      waitForHuman: true,
      onIntervention: async (iv, operator) => {
        await operator.click('Acknowledge')
        await interventions.resolve(iv.id, 'cleared the compliance notice')
      },
    })

    expect(r.status).toBe('success')
    const c = await new FileStore(dir).loadCapability(REF)
    expect(c.approval.replayStats).toMatchObject({ attempts: 1, successes: 1 })
  }, 60_000)

  it('blocks with a clear reason when nobody resolves the intervention in time', async () => {
    const r = await replay({
      ref: REF, tenant: 'firstvalley-cu', params: { memberId: '40021' }, storeRoot: dir,
      headless: true, policyOverride: policy,
      entryPointOverride: base + '/member/search?inject=unknown-dialog',
      waitForHuman: true, humanTimeoutMs: 1500,
      // onIntervention deliberately omitted: nobody comes.
    })
    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.reason).toMatch(/no operator resolved it/)
  }, 30_000)

  it('approves a risky step once on a draft capability, one approval per mutating step', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    await store.saveCapability({ ...c, approval: { ...c.approval, state: 'draft' } })

    const interventions = new InterventionStore(dir)
    let interventionsRaised = 0

    const r = await replay({
      ref: REF, tenant: 'firstvalley-cu', params: { memberId: '40021' }, storeRoot: dir,
      headless: true, policyOverride: policy,
      waitForHuman: true,
      onIntervention: async (iv) => {
        interventionsRaised++
        await interventions.resolve(iv.id, 'approved by operator')
      },
    })

    expect(r.status).toBe('success')
    // Each mutating step (fill, then click) needs its own approval — that is the
    // intended behaviour, not a bug: a one-shot grant covers exactly one step.
    expect(interventionsRaised).toBeGreaterThan(1)

    const timeline = await readFile(join(r.evidence, 'timeline.jsonl'), 'utf8')
    expect(timeline).toContain('human.approved_step')
  }, 60_000)

  it('refuses the operator handle while the agent still holds the lease', async () => {
    const surface = new WebSurface(policy, true)
    surface.setContext({ leaseHeld: true })
    await expect(surface.operatorHandle().click('Inquire')).rejects.toBeInstanceOf(PolicyError)
  })

  // C1 regression: evidence/rep_51bad52a shows a live run where, after the s2
  // (click Inquire) handback, the engine re-entered the step, ran outcome
  // detection at the top of the loop, and reported MEMBER_NOT_FOUND straight off
  // the page the human's own action had left on screen — never clicking Inquire
  // itself. This reproduces that exact shape live: the operator is handed the
  // step, drives the browser somewhere this step's own target cannot be found,
  // and hands back. The fix must not read an outcome off that page; it must
  // re-resolve its own target first, find nothing, and block honestly instead.
  it('does not read a business outcome off a page a human moved during a handback (C1)', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    await store.saveCapability({ ...c, approval: { ...c.approval, state: 'draft' } })

    const interventions = new InterventionStore(dir)

    const r = await replay({
      ref: REF, tenant: 'firstvalley-cu', params: { memberId: '40021' }, storeRoot: dir,
      headless: true, policyOverride: policy,
      waitForHuman: true, humanTimeoutMs: 3000,
      onIntervention: async (iv, operator) => {
        if (iv.reason === 'unapproved_mutation:fill') {
          // Let s1 proceed normally: no navigation, nothing to detect wrongly yet.
          await interventions.resolve(iv.id, 'approved by duty officer')
          return
        }
        if (iv.reason === 'unapproved_mutation:click') {
          // The human takes the wheel for s2 and drives off to a page that has no
          // "Inquire" button at all — the nav frame's own page — rather than doing
          // the click themselves. This is the drift the old code trusted blindly.
          await operator.navigate(base + '/nav')
          await interventions.resolve(iv.id, 'checking something else first')
          return
        }
        // The retried s2 intervention comes back as `page_moved_during_handoff`.
        // Nobody resolves it: the correct ending here is an honest `blocked`, not
        // a guess, so onIntervention deliberately does nothing for this one.
      },
    })

    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.reason).toMatch(/page_moved_during_handoff/)

    const timeline = await readFile(join(r.evidence, 'timeline.jsonl'), 'utf8')
    // The bug this closes: outcome detection must never fire between a handback
    // and this run re-resolving its own step's target on the live page.
    expect(timeline).not.toContain('business_outcome')
    expect(timeline).toContain('page_moved_during_handoff')
  }, 30_000)
})
