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

  it('returns a structured failure for an unknown capability instead of throwing', async () => {
    const r = await replay({ ref: 'quest-core/nope@1.0.0', tenant: 'firstvalley-cu', params: {}, storeRoot: dir, headless: true, policyOverride: policy })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.class).toBe('input_invalid')
  }, 60_000)

  it('counts a blocked run as an attempt without a success', async () => {
    await run({ memberId: '40021' }, base + '/member/search?inject=unknown-dialog')
    const c = await new FileStore(dir).loadCapability(REF)
    expect(c.approval.replayStats.attempts).toBe(1)
    expect(c.approval.replayStats.successes).toBe(0)
  }, 60_000)
})

describe('per-step timeout budgets', () => {
  // A short step budget against the target app's injected slow response, on the
  // mid-flow "click Inquire" step (s2) rather than the initial page load — see
  // target-app/server.ts's searchForm(slowInquire) for why the inject has to be
  // carried on the form's own action to land on the POST.
  const tightenStepTwo = async (): Promise<void> => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    const steps = c.steps.map((s) =>
      s.id === 's2'
        ? { ...s, timeoutMs: 700, onError: [{ when: 'timeout' as const, do: 'retry' as const, max: 2, backoffMs: 400 }] }
        : s,
    )
    await store.saveCapability({ ...c, steps })
  }

  it('fails with step_timeout, naming the step, when a mid-flow step exceeds its budget', async () => {
    await tightenStepTwo()
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=slow-inquire')

    expect(r.status).toBe('failed')
    if (r.status !== 'failed') return
    expect(r.class).toBe('step_timeout')
    expect(r.step).toBe('s2')
    expect(r.expected).toBeTruthy()
    expect(r.observed).toBeTruthy()
  }, 60_000)

  // A click that itself never returns in time (the mid-flow case above) has
  // nothing left to recover into: Playwright's own click timeout already fired,
  // and the action either fired or didn't — there is no safe "wait and recheck"
  // for an ambiguous half-done click. The `timeout` rung's wait-and-recheck loop
  // is for the other case: an action that already returned, or a target that
  // simply hasn't appeared yet, where re-observing the same screen after a beat
  // is safe. This drives that path directly with a target that never appears, so
  // the count of retries is deterministic instead of riding on server timing.
  //
  // F51: `timeoutMs`/`backoffMs` are chosen so `max` exhausts LONG before the
  // step's own deadline does (2 * 50ms = 100ms of enforced waiting against a
  // 3000ms budget). That gap is what makes this test able to fail: with `max`
  // enforced, recovery gives up at 2 waits and the run blocks on the still-
  // unresolved target with ~2900ms of budget left over. If enforcement were
  // ever removed, the same "target never appears" condition would make the
  // rung fire roughly every 50ms until the full 3000ms deadline was consumed —
  // dozens of `step.waited` events and a `step_timeout` result instead of a
  // `blocked` one. A test whose numbers let `max` and the deadline expire at
  // the same moment (as an earlier version of this test did) cannot tell those
  // two outcomes apart; this one can, and was confirmed red with the `max`
  // check deleted before being restored — see wave2-report.md.
  it('retries the timeout recovery rung exactly `max` times and no more, even though the step still has time left', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    const steps = c.steps.map((s) =>
      s.id === 's2'
        ? {
            ...s,
            target: { role: 'button' as const, name: 'This Button Does Not Exist', framePath: [], fallbacks: [] },
            timeoutMs: 3000,
            onError: [{ when: 'timeout' as const, do: 'retry' as const, max: 2, backoffMs: 50 }],
          }
        : s,
    )
    await store.saveCapability({ ...c, steps })

    const r = await run({ memberId: '40021' })
    // Recovery gives up long before the deadline: the run blocks on the
    // unresolved target rather than ever reaching step_timeout.
    expect(r.status).toBe('blocked')

    const { readFile } = await import('node:fs/promises')
    const timeline = (await readFile(join(r.evidence, 'timeline.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; id?: string; rung?: string })
    const waited = timeline.filter((e) => e.type === 'step.waited' && e.id === 's2' && e.rung === 'timeout')
    expect(waited.length).toBe(2)
  }, 15_000)

  it('still succeeds on a normal fast run with the same tightened step budget', async () => {
    await tightenStepTwo()
    const r = await run({ memberId: '40021' })
    expect(r.status).toBe('success')
    if (r.status === 'success') expect(r.outputs.savingsBalance).toBe(1284.55)
  }, 60_000)
})

// The frameset at "/" had never been exercised end to end: every other test in
// this file enters /member/search directly, so framePath was always [] and
// route-scoped outcomes never had to survive a top-level URL that stays put while
// an inner frame navigates. This is the F48 test.
describe('replay through the frameset at /', () => {
  const REF_FRAMESET = 'quest-core/member.savings_balance.frameset@1.0.0'
  const TENANT_FRAMESET = 'firstvalley-cu-frameset'

  const framesetTrace = (): Trace => ({
    goal: 'look up a member savings balance through the frameset', runId: 'disc_frameset_test',
    entryPoint: base + '/', model: 'test-model',
    steps: [
      { intent: 'Type the member number', action: 'fill', resolvedVia: 'primary', value: '40021',
        target: { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] },
        urlAfter: base + '/member/search', textAfter: 'Member No.' },
      { intent: 'Submit the inquiry', action: 'click', resolvedVia: 'primary',
        target: { role: 'button', name: 'Inquire', framePath: ['main'], fallbacks: [] },
        urlAfter: base + '/member/inquire', textAfter: 'Member A. Whitfield (40021)\nShare Balance\n1284.55' },
    ],
    extracted: {
      savingsBalance: {
        value: 'Share Balance 1284.55', as: 'number',
        from: {
          role: 'table', name: '', framePath: ['main'], fallbacks: [],
          anchor: { kind: 'table-cell', rowHeader: 'Share Balance', offset: { col: 1 } },
        },
      },
    },
    observedOutcomes: [], finalText: 'Member A. Whitfield (40021)\nShare Balance\n1284.55',
  })

  beforeEach(async () => {
    const store = new FileStore(dir)
    const cap = compile(framesetTrace(), { key: 'quest-core/member.savings_balance.frameset', params: { memberId: '40021' } })
    await store.saveCapability({ ...cap, approval: { ...cap.approval, state: 'approved' } })
    await store.saveBinding({
      tenant: TENANT_FRAMESET, capability: REF_FRAMESET, entryPoint: base + '/',
      overrides: {}, driftLog: [],
    })
  })

  const runFrameset = (params: Record<string, unknown>) =>
    replay({ ref: REF_FRAMESET, tenant: TENANT_FRAMESET, params, storeRoot: dir, headless: true, policyOverride: policy })

  it('resolves and fills Member No. inside "main", clicks Inquire, and extracts the balance', async () => {
    const r = await runFrameset({ memberId: '40021' })
    expect(r.status).toBe('success')
    if (r.status === 'success') expect(r.outputs.savingsBalance).toBe(1284.55)
  }, 60_000)

  it('F48: returns business_outcome/MEMBER_NOT_FOUND for a lookup made through the frameset', async () => {
    // Before this fix, detectBusinessOutcome compared the outcome's declared route
    // against the TOP-LEVEL page URL, which stays at "/" for the whole run here —
    // the "main" child frame is the one that actually navigates to
    // /member/inquire. Confirmed by hand that reverting the frame-aware pathname
    // comparison in src/replay/outcomes.ts back to `pathnameOf(surface.url())`
    // turns this test red (status: 'failed', not 'business_outcome') before
    // restoring the fix — see wave3-report.md.
    const r = await runFrameset({ memberId: '99999' })
    expect(r.status).toBe('business_outcome')
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_NOT_FOUND')
  }, 60_000)
})

describe('F49: the entry navigation is bounded by the first step\'s timeout', () => {
  it('fails with step_timeout at "(entry)" when the entry page overruns a tight first-step budget', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    const steps = c.steps.map((s, i) => (i === 0 ? { ...s, timeoutMs: 200 } : s))
    await store.saveCapability({ ...c, steps, approval: { ...c.approval, state: 'approved' } })

    const r = await run({ memberId: '40021' }, base + '/member/search?inject=slow')
    expect(r.status).toBe('failed')
    if (r.status === 'failed') {
      expect(r.class).toBe('step_timeout')
      expect(r.step).toBe('(entry)')
    }
  }, 15_000)

  it('still succeeds through a normal (fast) entry page with the same tight first-step budget', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    const steps = c.steps.map((s, i) => (i === 0 ? { ...s, timeoutMs: 200 } : s))
    await store.saveCapability({ ...c, steps, approval: { ...c.approval, state: 'approved' } })

    const r = await run({ memberId: '40021' })
    expect(r.status).toBe('success')
  }, 15_000)
})
