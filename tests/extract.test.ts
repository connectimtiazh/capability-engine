import { describe, it, expect } from 'vitest'
import { extractAnchored } from '../src/replay/extract.js'

const screen = 'Member\tA. Whitfield (40021)\nShare Balance\t1284.55\nAs Of\t2026-09-17'

describe('extractAnchored', () => {
  it('returns a number, not the screen', () => {
    expect(extractAnchored(screen, 'Share Balance', 'number')).toEqual({ ok: true, value: 1284.55 })
  })
  it('strips currency symbols and thousands separators', () => {
    expect(extractAnchored('Share Balance\t$12,284.55', 'Share Balance', 'number')).toEqual({ ok: true, value: 12284.55 })
  })
  it('reads an ISO date', () => {
    expect(extractAnchored(screen, 'As Of', 'date')).toEqual({ ok: true, value: '2026-09-17' })
  })
  it('fails loudly when the label is absent', () => {
    expect(extractAnchored(screen, 'Loan Balance', 'number')).toMatchObject({ ok: false })
  })
  it('fails loudly when the value is not a number', () => {
    expect(extractAnchored('Share Balance\tN/A', 'Share Balance', 'number')).toMatchObject({ ok: false })
  })
  it('does not read a neighbouring row', () => {
    expect(extractAnchored(screen, 'Share Balance', 'number')).not.toMatchObject({ value: 40021 })
  })
})
