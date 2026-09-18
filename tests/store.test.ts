import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/capability/store.js'
import type { Capability } from '../src/capability/schema.js'

const cap = (over: Partial<Capability> = {}): Capability => ({
  apiVersion: 'capability/v1',
  key: 'quest-core/member.savings_balance',
  version: '1.0.0',
  title: 'Look up balance',
  description: 'desc',
  surface: { kind: 'web' },
  vendor: { product: 'quest-core' },
  inputs: { type: 'object', required: ['memberId'], properties: { memberId: { type: 'string' } } },
  outputs: { type: 'object', required: [], properties: { savingsBalance: { type: 'number' } } },
  steps: [{ id: 's1', intent: 'i', action: 'click', target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] }, checkpoint: { kind: 'text-present', text: 'Share Balance' }, onError: [], timeoutMs: 8000 }],
  successCondition: { kind: 'text-present', text: 'Share Balance' },
  businessOutcomes: [],
  risk: { class: 'read', irreversible: false, requiresApproval: false },
  provenance: { discoveredBy: 't', discoveryRunId: 'r', recordedAt: '2026-09-17T00:00:00Z', humanEdits: [] },
  approval: { state: 'draft', replayStats: { attempts: 0, successes: 0, lastFailure: null } },
  ...over,
})

let dir: string
let store: FileStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cap-store-'))
  store = new FileStore(dir)
})

describe('FileStore', () => {
  it('round-trips a capability', async () => {
    await store.saveCapability(cap())
    const got = await store.loadCapability('quest-core/member.savings_balance@1.0.0')
    expect(got.title).toBe('Look up balance')
  })

  it('throws a clear error for a missing capability', async () => {
    await expect(store.loadCapability('nope@1.0.0')).rejects.toThrow(/capability not found: nope@1.0.0/)
  })

  it('applies a binding step override on resolveForTenant', async () => {
    await store.saveCapability(cap())
    await store.saveBinding({
      tenant: 'firstvalley-cu',
      capability: 'quest-core/member.savings_balance@1.0.0',
      entryPoint: 'http://localhost:4000/member/search',
      overrides: { steps: { s1: { target: { role: 'button', name: 'Inquire Now', framePath: [], fallbacks: [] } } } },
      driftLog: [],
    })
    const { capability } = await store.resolveForTenant('quest-core/member.savings_balance@1.0.0', 'firstvalley-cu')
    expect(capability.steps[0]!.target!.name).toBe('Inquire Now')
  })

  it('leaves the capability untouched when the tenant has no binding', async () => {
    await store.saveCapability(cap())
    const { capability, binding } = await store.resolveForTenant('quest-core/member.savings_balance@1.0.0', 'other-cu')
    expect(binding).toBeNull()
    expect(capability.steps[0]!.target!.name).toBe('Inquire')
  })

  it('accumulates a drift count per step and rung', async () => {
    await store.saveCapability(cap())
    await store.saveBinding({
      tenant: 'firstvalley-cu', capability: 'quest-core/member.savings_balance@1.0.0',
      entryPoint: 'http://localhost:4000/member/search', overrides: {}, driftLog: [],
    })
    await store.recordDrift('firstvalley-cu', 'quest-core/member.savings_balance', 's1', 'fallback[0]')
    await store.recordDrift('firstvalley-cu', 'quest-core/member.savings_balance', 's1', 'fallback[0]')
    const b = await store.loadBinding('firstvalley-cu', 'quest-core/member.savings_balance')
    expect(b!.driftLog[0]).toMatchObject({ step: 's1', resolvedVia: 'fallback[0]', count: 2 })
  })

  it('accumulates replay stats', async () => {
    await store.saveCapability(cap())
    const ref = 'quest-core/member.savings_balance@1.0.0'
    await store.recordReplayAttempt(ref, true, null)
    await store.recordReplayAttempt(ref, false, 'checkpoint_failed at s1')
    const got = await store.loadCapability(ref)
    expect(got.approval.replayStats).toMatchObject({ attempts: 2, successes: 1, lastFailure: 'checkpoint_failed at s1' })
  })
})
