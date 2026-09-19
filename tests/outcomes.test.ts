import { describe, it, expect } from 'vitest'
import { detectBusinessOutcome, type CheckpointCapable } from '../src/replay/outcomes.js'
import type { BusinessOutcome, Checkpoint } from '../src/capability/schema.js'

/** A fake surface whose page text and URL are set directly, so route-scoping can be
 *  tested without a browser. checkpointHolds only implements the text-present
 *  substring predicate the real WebSurface uses for this kind of check.
 *
 *  frameUrls models a frameset: a named frame's own URL, independent of the
 *  top-level page's URL — the exact fact F48 needs, since inside a frameset the
 *  top URL never changes while the named child frame navigates. A path with no
 *  entry in the map falls back to the top-level URL, matching WebSurface.frameFor's
 *  own fallback for a frame name that doesn't exist on the page. */
class FakeSurface implements CheckpointCapable {
  constructor(
    private readonly pageUrl: string,
    private readonly text: string,
    private readonly frameUrls: Record<string, string> = {},
  ) {}
  url(): string {
    return this.pageUrl
  }
  frameUrl(framePath: string[]): string {
    return this.frameUrls[framePath.join('/')] ?? this.pageUrl
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

  // F48
  it('fires a frame-scoped route outcome against the named frame\'s own URL, not the top page', async () => {
    // The top-level page never leaves "/" — exactly what a frameset entry point
    // looks like — while the "main" child frame has navigated to /member/inquire.
    // A comparison against surface.url() alone would never match this outcome's
    // declared route.
    const surface = new FakeSurface(
      'http://localhost:4000/', 'No record found',
      { main: 'http://localhost:4000/member/inquire' },
    )
    const framed: BusinessOutcome = {
      ...outcome('/member/inquire'),
      detect: { kind: 'text-present', text: 'No record found', framePath: ['main'] },
      when: { route: '/member/inquire', framePath: ['main'] },
    }
    const hit = await detectBusinessOutcome(surface, [framed])
    expect(hit?.code).toBe('MEMBER_NOT_FOUND')
  })

  it('does not fire a frame-scoped outcome when only an unrelated frame matches the route', async () => {
    const surface = new FakeSurface(
      'http://localhost:4000/', 'No record found',
      { nav: 'http://localhost:4000/member/inquire' },
    )
    const framed: BusinessOutcome = {
      ...outcome('/member/inquire'),
      detect: { kind: 'text-present', text: 'No record found', framePath: ['main'] },
      when: { route: '/member/inquire', framePath: ['main'] },
    }
    const hit = await detectBusinessOutcome(surface, [framed])
    expect(hit).toBeNull()
  })
})
