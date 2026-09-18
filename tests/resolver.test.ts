import { describe, it, expect } from 'vitest'
import { resolveDescriptor, type A11yNode } from '../src/surface/resolver.js'

const node = (over: Partial<A11yNode>): A11yNode => ({
  role: 'textbox', name: '', framePath: ['main'], ref: 'r1', ...over,
})

describe('resolveDescriptor', () => {
  it('matches exactly one node by role and accessible name', () => {
    const nodes = [node({ name: 'Member No.', ref: 'a' }), node({ role: 'button', name: 'Inquire', ref: 'b' })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toMatchObject({ kind: 'one', via: 'primary' })
    expect(r.kind === 'one' && r.node.ref).toBe('a')
  })

  it('returns none when nothing matches', () => {
    const r = resolveDescriptor([node({ name: 'Other' })], { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toEqual({ kind: 'none' })
  })

  it('returns ambiguous when two nodes match, rather than picking the first', () => {
    const nodes = [node({ name: 'Member No.', ref: 'a' }), node({ name: 'Member No.', ref: 'b' })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('does not match across frames', () => {
    const nodes = [node({ name: 'Member No.', framePath: ['nav'] })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toEqual({ kind: 'none' })
  })

  it('falls back to labelText when the accessible name is empty', () => {
    const nodes = [node({ name: '', labelText: 'Member No.', ref: 'a' })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toMatchObject({ kind: 'one', via: 'labelText' })
  })

  it('falls back to the name attribute and reports the rung it used', () => {
    const nodes = [node({ name: '', nameAttr: 'ctl00$mbrNo', ref: 'a' })]
    const r = resolveDescriptor(nodes, {
      role: 'textbox', name: 'Member No.', framePath: ['main'],
      fallbacks: [{ strategy: 'name-attr', value: 'ctl00$mbrNo' }],
    })
    expect(r).toMatchObject({ kind: 'one', via: 'fallback[0]:name-attr' })
  })

  it('prefers the primary descriptor over an available fallback', () => {
    const nodes = [node({ name: 'Member No.', nameAttr: 'ctl00$mbrNo', ref: 'a' })]
    const r = resolveDescriptor(nodes, {
      role: 'textbox', name: 'Member No.', framePath: ['main'],
      fallbacks: [{ strategy: 'name-attr', value: 'ctl00$mbrNo' }],
    })
    expect(r).toMatchObject({ via: 'primary' })
  })
})
