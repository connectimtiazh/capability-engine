import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../target-app/server.js'
import { runDiscovery } from '../src/discover/loop.js'
import type { ModelClient, ProposedAction } from '../src/discover/model.js'

const PORT = 4113
const base = `http://localhost:${PORT}`
let server: Server

beforeAll(async () => {
  server = createServer().listen(PORT)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

/** A scripted stand-in for the model, so the loop itself is testable without
 *  spending tokens. The real model run is the CLI demo, recorded in /evidence. */
class ScriptedModel implements ModelClient {
  readonly name = 'scripted'
  private i = 0
  constructor(private readonly script: ProposedAction[]) {}
  async propose(): Promise<ProposedAction> {
    const next = this.script[this.i++]
    if (!next) throw new Error('script exhausted')
    return next
  }
}

describe('runDiscovery', () => {
  it('drives the surface to the goal and emits a trace', async () => {
    const store = await mkdtemp(join(tmpdir(), 'disc-'))
    const model = new ScriptedModel([
      { kind: 'act', action: 'fill', intent: 'Type the member number', value: '40021',
        target: { role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] } },
      { kind: 'act', action: 'click', intent: 'Submit the inquiry',
        target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] } },
      { kind: 'extract', name: 'savingsBalance', as: 'number', intent: 'Read the share balance',
        from: { role: 'table', name: '', framePath: [], fallbacks: [] } },
      { kind: 'done', summary: 'read the balance' },
    ])

    const trace = await runDiscovery({
      goal: 'look up member 40021 and read their savings balance',
      entryPoint: base + '/member/search',
      model, storeRoot: store, headless: true, maxSteps: 10,
      policyOverride: {
        allowedOrigins: [base],
        allowedPathPrefixes: ['/', '/nav', '/member'],
        allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
      },
    })

    expect(trace.steps).toHaveLength(2)
    expect(trace.steps[0]!.action).toBe('fill')
    expect(trace.extracted.savingsBalance!.value).toContain('1284.55')
    expect(trace.observedOutcomes.length).toBeGreaterThan(0)
  })

  it('stops with a stuck trace when the model gives up', async () => {
    const store = await mkdtemp(join(tmpdir(), 'disc-'))
    const model = new ScriptedModel([{ kind: 'stuck', why: 'cannot find the control' }])
    await expect(
      runDiscovery({
        goal: 'g', entryPoint: base + '/member/search', model, storeRoot: store,
        headless: true, maxSteps: 5,
        policyOverride: { allowedOrigins: [base], allowedPathPrefixes: ['/', '/member'], allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'] },
      }),
    ).rejects.toThrow(/stuck: cannot find the control/)
  })

  it('stops at the step budget rather than looping forever', async () => {
    const store = await mkdtemp(join(tmpdir(), 'disc-'))
    const loop: ProposedAction = {
      kind: 'act', action: 'click', intent: 'click forever',
      target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
    }
    const model = new ScriptedModel([loop, loop, loop, loop, loop, loop])
    await expect(
      runDiscovery({
        goal: 'g', entryPoint: base + '/member/search', model, storeRoot: store,
        headless: true, maxSteps: 3,
        policyOverride: { allowedOrigins: [base], allowedPathPrefixes: ['/', '/member'], allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'] },
      }),
    ).rejects.toThrow(/step budget/)
  })
})
