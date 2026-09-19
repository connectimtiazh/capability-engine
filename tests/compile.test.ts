import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { compile } from '../src/compile/compile.js'
import { CapabilitySchema } from '../src/capability/schema.js'
import type { Trace } from '../src/discover/loop.js'

const trace: Trace = {
  goal: 'look up member 40021 and read their savings balance',
  runId: 'disc_abc', entryPoint: 'http://localhost:4000/member/search', model: 'test-model',
  steps: [
    { intent: 'Type the member number', action: 'fill', resolvedVia: 'primary', value: '40021',
      target: { role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] },
      urlAfter: 'http://localhost:4000/member/search', textAfter: 'Member No.' },
    { intent: 'Submit the inquiry', action: 'click', resolvedVia: 'primary',
      target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
      urlAfter: 'http://localhost:4000/member/inquire', textAfter: 'Share Balance\n1284.55\nAs Of 2026-09-17' },
  ],
  extracted: { savingsBalance: { value: 'Share Balance 1284.55', as: 'number', from: { role: 'table', name: '', framePath: [], fallbacks: [] } } },
  observedOutcomes: [{ text: 'Member No.', url: 'http://localhost:4000/member/search' }],
  finalText: 'Share Balance\n1284.55\nAs Of 2026-09-17',
}

describe('compile', () => {
  it('produces a schema-valid capability', () => {
    const c = compile(trace, { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
    expect(() => CapabilitySchema.parse(c)).not.toThrow()
  })

  it('lifts a concrete value into a typed input parameter', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.inputs.properties.memberId).toBeDefined()
    expect(c.steps[0]!.value).toEqual({ fromInput: 'memberId' })
  })

  it('never leaves the concrete recorded value in a step', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(JSON.stringify(c.steps)).not.toContain('40021')
  })

  it('marks the lifted parameter as pii by default', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.inputs.properties.memberId!['x-sensitivity']).toBe('pii')
  })

  it('declares an output for each extraction', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.outputs.properties.savingsBalance).toEqual({ type: 'number' })
    expect(c.outputs.required).toContain('savingsBalance')
  })

  it('anchors the extract step checkpoint on the anchor label, not a novelty-derived line', () => {
    const anchoredTrace: Trace = {
      ...trace,
      extracted: {
        savingsBalance: {
          value: '1284.55', as: 'number',
          from: {
            role: 'table', name: '', framePath: [], fallbacks: [],
            anchor: { kind: 'table-cell', rowHeader: 'Share Balance', offset: { col: 1 } },
          },
        },
      },
    }
    const c = compile(anchoredTrace, { key: 'k', params: { memberId: '40021' } })
    const extractStep = c.steps.find((s) => s.action === 'read')!
    expect(extractStep.checkpoint).toEqual({ kind: 'text-present', text: 'Share Balance', framePath: [] })
  })

  it('derives a success condition from the final screen', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.successCondition).toMatchObject({ kind: 'text-present' })
  })

  it('gives every step a checkpoint', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.steps.every((s) => s.checkpoint)).toBe(true)
  })

  it('classifies interaction as ui_mutation when any step mutates the UI', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.risk.interaction).toBe('ui_mutation')
  })

  it('defaults business risk to unclassified until a human or model says otherwise', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.risk.business).toBe('unclassified')
    expect(c.risk.businessSetBy).toBe('default')
  })

  it('records a model-proposed business risk as a hint, not authority', () => {
    const c = compile({ ...trace, businessRiskProposed: 'irreversible' }, { key: 'k', params: { memberId: '40021' } })
    expect(c.risk.business).toBe('irreversible')
    expect(c.risk.businessSetBy).toBe('model-proposed')
  })

  it('starts at version 1.0.0 in draft', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.version).toBe('1.0.0')
    expect(c.approval.state).toBe('draft')
  })

  it('carries provenance naming the model and the discovery run', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.provenance).toMatchObject({ discoveredBy: 'test-model', discoveryRunId: 'disc_abc' })
  })

  it('never anchors a checkpoint on a line carrying a parameter value', () => {
    const memberSpecific: Trace = {
      ...trace,
      steps: [
        trace.steps[0]!,
        { ...trace.steps[1]!, textAfter: 'Member A. Whitfield (40021)\nShare Balance\n1284.55' },
      ],
      finalText: 'Member A. Whitfield (40021)\nShare Balance\n1284.55',
    }
    const c = compile(memberSpecific, { key: 'k', params: { memberId: '40021' } })
    expect(JSON.stringify(c.steps)).not.toContain('40021')
    expect(JSON.stringify(c.successCondition)).not.toContain('40021')
    expect(JSON.stringify(c.successCondition)).toContain('Share Balance')
  })

  it('parameterises the title rather than embedding the recorded value', () => {
    const c = compile({ ...trace, goal: 'look up member 40021 and read their savings balance' },
      { key: 'k', params: { memberId: '40021' } })
    expect(c.title).toBe('look up member {memberId} and read their savings balance')
    expect(JSON.stringify({ t: c.title, d: c.description })).not.toContain('40021')
  })

  it('refuses to anchor a checkpoint on a recorded output value', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    const emitted = JSON.stringify({ s: c.steps, ok: c.successCondition })
    expect(emitted).not.toContain('1284.55')
    expect(emitted).not.toContain('2026-09-17')
  })

  it('throws rather than emitting a checkpoint anchored on a volatile value', () => {
    const singleLine: Trace = {
      ...trace,
      steps: [
        trace.steps[0]!,
        { ...trace.steps[1]!, textAfter: 'Share Balance 1284.55 As Of 2026-09-17' },
      ],
      finalText: 'Share Balance 1284.55 As Of 2026-09-17',
    }
    expect(() => compile(singleLine, { key: 'k', params: { memberId: '40021' } }))
      .toThrow(/cannot derive a checkpoint/)
  })

  it('substitutes overlapping parameter values longest-first', () => {
    const c = compile(
      { ...trace, goal: 'reconcile member 400 against account 40021' },
      { key: 'k', params: { memberId: '400', accountId: '40021' } },
    )
    expect(c.title).toBe('reconcile member {memberId} against account {accountId}')
  })

  it('loads business outcomes from the vendor registry, scoped to a route', () => {
    const c = compile(trace, { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
    expect(c.businessOutcomes.length).toBeGreaterThan(0)
    for (const o of c.businessOutcomes) {
      expect(o.when?.route).toBe('/member/inquire')
    }
    expect(c.businessOutcomes.map((o) => o.code)).toContain('MEMBER_NOT_FOUND')
  })

  it('compiles with zero business outcomes when the vendor has no registry file', () => {
    const c = compile(trace, { key: 'unregistered-vendor/some.capability', params: { memberId: '40021' } })
    expect(c.businessOutcomes).toEqual([])
  })

  describe('a malformed vendor outcome registry', () => {
    const badPath = 'vendors/__wave3-malformed-test-vendor.outcomes.json'

    afterEach(() => {
      if (existsSync(badPath)) unlinkSync(badPath)
    })

    it('names the file and the parse problem instead of a raw JSON.parse stack', () => {
      writeFileSync(badPath, '{ this is not valid JSON', 'utf8')
      expect(() => compile(trace, { key: '__wave3-malformed-test-vendor/some.capability', params: { memberId: '40021' } }))
        .toThrow(/__wave3-malformed-test-vendor\.outcomes\.json/)
    })
  })

  it('infers a digits-only pattern from an all-digits sample, not the sample length', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.inputs.properties.memberId!.pattern).toBe('^[0-9]+$')
    // A 6-digit member must not be rejected by a pattern derived from a 5-digit sample.
    expect('123456').toMatch(new RegExp(c.inputs.properties.memberId!.pattern as string))
  })

  it('emits no pattern for a non-numeric sample', () => {
    const c = compile(trace, { key: 'k', params: { memberId: 'AB-40021' } })
    expect(c.inputs.properties.memberId!.pattern).toBeUndefined()
  })

  it('emits field-value-matches-input for a fill whose value came from an input', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    const fillStep = c.steps.find((s) => s.action === 'fill')!
    expect(fillStep.checkpoint).toEqual({
      kind: 'field-value-matches-input', role: 'textbox', name: 'Member No.', framePath: [], input: 'memberId',
    })
  })

  it('treats each table cell as a candidate, as real innerText joins cells with tabs', () => {
    const tabbed = 'Member\tA. Whitfield (40021)\nShare Balance\t1284.55\nAs Of\t2026-09-17'
    const c = compile(
      {
        ...trace,
        steps: [trace.steps[0]!, { ...trace.steps[1]!, textAfter: tabbed }],
        finalText: tabbed,
        extracted: { savingsBalance: { value: tabbed, as: 'number', from: { role: 'table', name: '', framePath: [], fallbacks: [] } } },
      },
      { key: 'k', params: { memberId: '40021' } },
    )
    expect(c.successCondition).toMatchObject({ kind: 'text-present', text: 'Share Balance' })
    const emitted = JSON.stringify({ s: c.steps, ok: c.successCondition })
    expect(emitted).not.toContain('40021')
    expect(emitted).not.toContain('1284.55')
  })
})
