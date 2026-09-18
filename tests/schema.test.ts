import { describe, it, expect } from 'vitest'
import { CapabilitySchema, BindingSchema, capabilityRef } from '../src/capability/schema.js'

const valid = {
  apiVersion: 'capability/v1',
  key: 'quest-core/member.savings_balance',
  version: '1.0.0',
  title: 'Look up a member savings balance',
  description: 'Returns the share balance for a member number.',
  surface: { kind: 'web' },
  vendor: { product: 'quest-core', observedVersion: '8.3' },
  inputs: {
    type: 'object',
    required: ['memberId'],
    properties: { memberId: { type: 'string', pattern: '^[0-9]{5}$', 'x-sensitivity': 'pii' } },
  },
  outputs: {
    type: 'object',
    required: ['savingsBalance'],
    properties: { savingsBalance: { type: 'number' } },
  },
  steps: [
    {
      id: 's1',
      intent: 'Type the member number',
      action: 'fill',
      target: { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] },
      value: { fromInput: 'memberId' },
      checkpoint: { kind: 'field-has-value', role: 'textbox', name: 'Member No.' },
      onError: [],
      timeoutMs: 8000,
    },
  ],
  successCondition: { kind: 'text-present', framePath: ['main'], text: 'Share Balance' },
  businessOutcomes: [
    { code: 'MEMBER_NOT_FOUND', detect: { kind: 'text-present', text: 'No record found' }, terminal: true, message: 'No such member.' },
  ],
  risk: { class: 'read', irreversible: false, requiresApproval: false },
  provenance: { discoveredBy: 'test', discoveryRunId: 'run_1', recordedAt: '2026-09-17T00:00:00Z', humanEdits: [] },
  approval: { state: 'draft', replayStats: { attempts: 0, successes: 0, lastFailure: null } },
}

describe('CapabilitySchema', () => {
  it('accepts a well-formed capability', () => {
    expect(() => CapabilitySchema.parse(valid)).not.toThrow()
  })

  it('rejects a non-semver version', () => {
    expect(() => CapabilitySchema.parse({ ...valid, version: 'v1' })).toThrow()
  })

  it('rejects an unknown result of risk.class', () => {
    expect(() => CapabilitySchema.parse({ ...valid, risk: { ...valid.risk, class: 'destroy' } })).toThrow()
  })

  it('requires at least one step', () => {
    expect(() => CapabilitySchema.parse({ ...valid, steps: [] })).toThrow()
  })

  it('builds a ref from key and version', () => {
    expect(capabilityRef(CapabilitySchema.parse(valid))).toBe('quest-core/member.savings_balance@1.0.0')
  })
})

describe('BindingSchema', () => {
  it('rejects an inline credential value', () => {
    expect(() =>
      BindingSchema.parse({
        tenant: 't', capability: 'k@^1.0.0', entryPoint: 'http://localhost:4000/member/search',
        credentials: { ref: 'hunter2' }, overrides: {}, driftLog: [],
      }),
    ).toThrow()
  })

  it('accepts an env-prefixed credential ref', () => {
    expect(() =>
      BindingSchema.parse({
        tenant: 't', capability: 'k@^1.0.0', entryPoint: 'http://localhost:4000/member/search',
        credentials: { ref: 'env:FOO' }, overrides: {}, driftLog: [],
      }),
    ).not.toThrow()
  })
})
