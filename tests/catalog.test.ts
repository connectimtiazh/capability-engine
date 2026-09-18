import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/capability/store.js'
import { compile } from '../src/compile/compile.js'
import { buildCatalog, toolDefinition } from '../src/catalog/catalog.js'
import type { Trace } from '../src/discover/loop.js'

const trace: Trace = {
  goal: 'look up a member savings balance', runId: 'r', entryPoint: 'http://localhost:4000/member/search',
  model: 'm',
  steps: [{ intent: 'i', action: 'click', resolvedVia: 'primary',
    target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
    urlAfter: 'http://localhost:4000/member/inquire', textAfter: 'Share Balance' }],
  extracted: { savingsBalance: { value: '1', as: 'number', from: { role: 'table', name: '', framePath: [], fallbacks: [] } } },
  observedOutcomes: [], finalText: 'Share Balance',
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cat-')) })

describe('catalog', () => {
  it('exposes a capability as a callable tool definition', async () => {
    const c = compile(trace, { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
    const t = toolDefinition(c)
    expect(t.name).toBe('quest_core__member_savings_balance')
    expect(t.parameters).toMatchObject({ type: 'object', required: ['memberId'] })
    expect(t.description).toContain('savingsBalance')
  })

  it('marks a draft capability as attended-only', async () => {
    const c = compile(trace, { key: 'k/x', params: { memberId: '40021' } })
    expect(toolDefinition(c).unattended).toBe(false)
    expect(toolDefinition({ ...c, approval: { ...c.approval, state: 'approved' } }).unattended).toBe(true)
  })

  it('never leaks a recorded sample value into the tool description', async () => {
    const c = compile(trace, { key: 'k/x', params: { memberId: '40021' } })
    expect(JSON.stringify(toolDefinition(c))).not.toContain('40021')
  })

  it('lists every saved capability', async () => {
    const store = new FileStore(dir)
    await store.saveCapability(compile(trace, { key: 'a/one', params: { memberId: '40021' } }))
    await store.saveCapability(compile(trace, { key: 'b/two', params: { memberId: '40021' } }))
    expect((await buildCatalog(store)).map((t) => t.name).sort()).toEqual(['a__one', 'b__two'])
  })
})
