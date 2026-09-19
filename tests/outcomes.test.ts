import { describe, it, expect } from 'vitest'
import { detectBusinessOutcome, type CheckpointCapable } from '../src/replay/outcomes.js'
import type { BusinessOutcome, Checkpoint } from '../src/capability/schema.js'

/** A fake surface whose page text and URL are set directly, so route-scoping can be
 *  tested without a browser. checkpointHolds only implements the text-present
 *  substring predicate the real WebSurface uses for this kind of check. */
class FakeSurface implements CheckpointCapable {
  constructor(private readonly pageUrl: string, private readonly text: string) {}
  url(): string {
    return this.pageUrl
  }
  async checkpointHolds(c: Checkpoint): Promise<{ ok: boolean; observed: string }> {
    if (c.kind !== 'text-present') throw new Error('fake only supports text-present')
    const ok = this.text.includes(c.text)
    return { ok, observed: ok ? `found "${c.text}"` : 'not found' }
  }
}

const outcome = (route: string): BusinessOutcome => ({
  code: 'MEMBER_NOT_FOUND',
  detect: { kind: 'text-present', text: 'No record found' },
  terminal: true,
  message: 'No such member.',
  when: { route },
})

describe('detectBusinessOutcome', () => {
  it('fires when the current page matches the outcome\'s scoped route', async () => {
    const surface = new FakeSurface('http://localhost:4000/member/inquire', 'No record found')
    const hit = await detectBusinessOutcome(surface, [outcome('/member/inquire')])
    expect(hit?.code).toBe('MEMBER_NOT_FOUND')
  })

  it('does not fire when the matching text sits on a different, unscoped page', async () => {
    // Same text, but the capability's outcome was authored against the inquiry
    // screen, not this one — an unrelated "No record found" elsewhere in the app
    // must never be attributed to this operation's result.
    const surface = new FakeSurface('http://localhost:4000/reports/monthly', 'No record found')
    const hit = await detectBusinessOutcome(surface, [outcome('/member/inquire')])
    expect(hit).toBeNull()
  })

  it('still fires for an outcome with no declared route (unscoped by choice)', async () => {
    const surface = new FakeSurface('http://localhost:4000/anywhere', 'No record found')
    const unscoped: BusinessOutcome = { ...outcome('/member/inquire'), when: undefined }
    const hit = await detectBusinessOutcome(surface, [unscoped])
    expect(hit?.code).toBe('MEMBER_NOT_FOUND')
  })
})
