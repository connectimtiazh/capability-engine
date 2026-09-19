import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright'
import { writeFile } from 'node:fs/promises'
import type { ActionKind, TargetDescriptor, Checkpoint } from '../capability/schema.js'
import { gate } from '../policy/gate.js'
import type { PolicyConfig } from '../policy/allowlist.js'
import { redactValue } from '../policy/redact.js'
import { resolveDescriptor } from './resolver.js'
import { PolicyError, SurfaceTimeoutError, type A11yNode, type FrameSnapshot, type Observation, type OperatorHandle, type Resolution } from './types.js'

export type { Observation, A11yNode, Resolution, FrameSnapshot, OperatorHandle } from './types.js'
export { PolicyError, SurfaceTimeoutError } from './types.js'

/** A step's remaining time budget, threaded through to whichever surface call is
 *  bounding it. Optional everywhere: omitting it preserves Playwright's own
 *  default timeout, so every call site that predates budgets keeps working. */
export interface Budget {
  timeoutMs?: number
}

const EXTRACT = `() => {
  const out = []
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'submit' || t === 'button') return 'button'
      if (t === 'checkbox') return 'checkbox'
      return 'textbox'
    }
    if (tag === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'select') return 'combobox'
    if (tag === 'table') return 'table'
    return null
  }
  const labelFor = (el) => {
    const cell = el.closest('td')
    const prev = cell && cell.previousElementSibling
    if (prev) return prev.textContent.trim()
    return ''
  }
  let i = 0
  for (const el of document.querySelectorAll('input,button,a,select,table')) {
    const role = roleOf(el)
    if (!role) continue
    const nameAttr = el.getAttribute('name') || undefined
    const attrValue = el.getAttribute('value') || ''
    const label = labelFor(el)
    const name =
      role === 'button' ? (attrValue || el.textContent.trim())
      : role === 'link' ? el.textContent.trim()
      : role === 'table' ? (el.textContent.trim().slice(0, 40))
      : label
    // The live current value of an input/select — el.value is the IDL property (what
    // the user actually typed or a script actually set), never the static HTML
    // attribute, which is what a checkpoint needs to tell "filled" from "empty".
    const liveValue = (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'select') ? (el.value ?? '') : ''
    el.setAttribute('data-cap-ref', 'n' + i)
    out.push({ role, name, nameAttr, labelText: label, ref: 'n' + (i++), value: liveValue })
  }
  return out
}`

export class WebSurface {
  private browser!: Browser
  private context!: BrowserContext
  private page!: Page
  private approvalState: 'draft' | 'approved' = 'draft'
  private leaseHeld = true
  private businessRisk: 'read' | 'mutation' | 'irreversible' | 'unclassified' = 'unclassified'
  private businessSetBy: 'model-proposed' | 'human-confirmed' | 'default' = 'default'

  constructor(private readonly policy: PolicyConfig, private readonly headless = false) {}

  setContext(c: {
    approvalState?: 'draft' | 'approved'
    leaseHeld?: boolean
    businessRisk?: 'read' | 'mutation' | 'irreversible' | 'unclassified'
    businessSetBy?: 'model-proposed' | 'human-confirmed' | 'default'
  }): void {
    if (c.approvalState) this.approvalState = c.approvalState
    if (c.leaseHeld !== undefined) this.leaseHeld = c.leaseHeld
    if (c.businessRisk) this.businessRisk = c.businessRisk
    if (c.businessSetBy) this.businessSetBy = c.businessSetBy
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless })
    try {
      this.context = await this.browser.newContext()
      this.page = await this.context.newPage()
    } catch (e) {
      // Don't leak a live browser process when only the context or page failed.
      await this.browser.close().catch(() => {})
      throw e
    }
  }

  /** Every action funnels through here. The gate lives inside the only module that
   *  can touch the surface, so neither discovery nor replay can route around it. */
  private check(action: ActionKind, url: string): void {
    const v = gate({
      action, url, policy: this.policy, approvalState: this.approvalState, leaseHeld: this.leaseHeld,
      businessRisk: this.businessRisk, businessSetBy: this.businessSetBy,
    })
    if (v.verdict !== 'PASS') throw new PolicyError(v.verdict, v.reason)
  }

  private frames(): { path: string[]; frame: Frame }[] {
    const out: { path: string[]; frame: Frame }[] = []
    for (const f of this.page.frames()) {
      const nm = f.name()
      out.push({ path: nm ? [nm] : [], frame: f })
    }
    return out
  }

  /** F49: the entry navigation ran unbounded, so a slow entry page hung on
   *  Playwright's own default instead of producing a timeout this run could report.
   *  Threaded the same way `act()` threads a step budget into Playwright's own
   *  `timeout` option: on overrun Playwright actually aborts the navigation, so by
   *  the time this throws nothing is still in flight. */
  async open(url: string, budget?: Budget): Promise<void> {
    this.check('navigate', url)
    // F50: Playwright treats `timeout: 0` as "no timeout at all," so a budget that
    // has hit exactly zero must never reach `page.goto()` — passing it through
    // would invert the feature at its own boundary case, waiting forever exactly
    // when the clock has run out. Same guard `observeBudgeted()` already has.
    if (budget?.timeoutMs !== undefined && budget.timeoutMs <= 0) {
      throw new SurfaceTimeoutError('step budget exhausted before navigation')
    }
    try {
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        ...(budget?.timeoutMs !== undefined ? { timeout: budget.timeoutMs } : {}),
      })
    } catch (e) {
      if (budget?.timeoutMs !== undefined && /timeout/i.test(String(e))) {
        throw new SurfaceTimeoutError(`open did not complete within ${budget.timeoutMs}ms: ${String(e)}`)
      }
      throw e
    }
  }

  async observe(): Promise<Observation> {
    this.check('read', this.page.url())
    const frames: FrameSnapshot[] = []
    for (const { path, frame } of this.frames()) {
      let nodes: Omit<A11yNode, 'framePath'>[] = []
      let text = ''
      try {
        // Playwright's evaluate(string) evaluates the string as an expression rather
        // than invoking it, so a stringified arrow function resolves to a function
        // value (which serializes to undefined) unless it is wrapped and called here.
        nodes = (await frame.evaluate(`(${EXTRACT})()`)) as Omit<A11yNode, 'framePath'>[]
        text = (await frame.evaluate('(() => document.body ? document.body.innerText : "")()')) as string
      } catch {
        continue
      }
      frames.push({ path, text, nodes: nodes.map((n) => ({ ...n, framePath: path })) })
    }
    return { url: this.page.url(), title: await this.page.title(), frames }
  }

  /** `observe()` is built on `frame.evaluate()`, which Playwright gives no timeout
   *  option for — there is nothing to race here, so the budget is checked before
   *  the call (skip it outright once the step's clock has already run out) and
   *  after it (catch a hang that somehow outran the budget anyway). Every read of
   *  the page — resolve, checkpointHolds, readText — goes through this one gate. */
  private async observeBudgeted(budget?: Budget): Promise<Observation> {
    if (budget?.timeoutMs !== undefined && budget.timeoutMs <= 0) {
      throw new SurfaceTimeoutError('step budget exhausted before observation')
    }
    const start = Date.now()
    const obs = await this.observe()
    if (budget?.timeoutMs !== undefined && Date.now() - start > budget.timeoutMs) {
      throw new SurfaceTimeoutError('step budget exhausted during observation')
    }
    return obs
  }

  async resolve(t: TargetDescriptor, budget?: Budget): Promise<Resolution> {
    const obs = await this.observeBudgeted(budget)
    return resolveDescriptor(obs.frames.flatMap((f) => f.nodes), t)
  }

  private frameFor(path: string[]): Frame {
    const hit = this.frames().find((f) => f.path.join('/') === path.join('/'))
    return hit?.frame ?? this.page.mainFrame()
  }

  /** F48: the one way to learn a specific frame's own URL. Inside a frameset the
   *  top-level document (page.url()) never changes — only the named child frame
   *  navigates — so a route-scoped outcome must be checked against the frame it
   *  was authored against, not the page. Falls back to the page's main frame (via
   *  frameFor's own fallback) when no frame with that name exists, which is exactly
   *  right for a capability recorded against a direct, unframed entry point. */
  frameUrl(path: string[]): string {
    return this.frameFor(path).url()
  }

  /** Bullet 2 of the timeout brief: the remaining budget is pushed INTO Playwright's
   *  own `timeout` option on the click/fill/selectOption call, never raced from out
   *  here. Racing would leave the real action running in the browser after this
   *  function returns a timeout — worse than no timeout, because now something is
   *  in flight nobody is tracking. Playwright's own timeout actually aborts the
   *  action, so when it fires the action really has stopped. That native error is
   *  wrapped as SurfaceTimeoutError so replay has one shape to catch regardless of
   *  which Playwright call (or action) produced it. */
  async act(action: ActionKind, node: A11yNode, value?: string, budget?: Budget): Promise<void> {
    this.check(action, this.page.url())
    // F50: same reason as `open()` — `{ timeout: 0 }` means "no timeout" to
    // Playwright, not "expired already." Without this guard, exactly the moment a
    // step's budget is exhausted (the case this feature exists to handle) is the
    // moment click/fill/selectOption would wait indefinitely instead. This also
    // covers the recovery rungs' `dismiss` calls, which reach here with whatever
    // `applyRecovery`'s own `remaining()` computed, and can legitimately be zero.
    if (budget?.timeoutMs !== undefined && budget.timeoutMs <= 0) {
      throw new SurfaceTimeoutError(`${action} budget exhausted before the action`)
    }
    const frame = this.frameFor(node.framePath)
    const loc = frame.locator(`[data-cap-ref="${node.ref}"]`)
    const opts = budget?.timeoutMs !== undefined ? { timeout: budget.timeoutMs } : undefined
    try {
      if (action === 'click') await loc.click(opts)
      else if (action === 'fill') await loc.fill(value ?? '', opts)
      else if (action === 'select') await loc.selectOption(value ?? '', opts)
      else if (action === 'dismiss') await loc.click(opts)
      else throw new Error(`act() cannot perform ${action}`)
    } catch (e) {
      if (budget?.timeoutMs !== undefined && /timeout/i.test(String(e))) {
        throw new SurfaceTimeoutError(`${action} did not complete within ${budget.timeoutMs}ms: ${String(e)}`)
      }
      throw e
    }
  }

  async checkpointHolds(
    c: Checkpoint,
    resolveInput?: (inputName: string) => string | undefined,
    budget?: Budget,
  ): Promise<{ ok: boolean; observed: string }> {
    const obs = await this.observeBudgeted(budget)
    const scope = (path?: string[]) =>
      path ? obs.frames.filter((f) => f.path.join('/') === path.join('/')) : obs.frames

    if (c.kind === 'text-present') {
      const frames = scope(c.framePath)
      const ok = frames.some((f) => f.text.includes(c.text))
      return { ok, observed: ok ? `found "${c.text}"` : `text not present; page text begins "${(frames[0]?.text ?? '').slice(0, 120)}"` }
    }
    if (c.kind === 'url-matches') {
      const ok = new RegExp(c.pattern).test(obs.url)
      return { ok, observed: obs.url }
    }
    const nodes = scope(c.framePath).flatMap((f) => f.nodes)
    if (c.kind === 'role-present') {
      const ok = nodes.some((n) => n.role === c.role && (!c.nameContains || n.name.includes(c.nameContains)))
      return { ok, observed: ok ? `role ${c.role} present` : `roles present: ${[...new Set(nodes.map((n) => n.role))].join(',')}` }
    }
    const match = nodes.find((n) => n.role === c.role && (n.name === c.name || n.labelText === c.name))
    if (c.kind === 'field-value-matches-input') {
      // A control existing, or even holding *something*, is not evidence this
      // invocation's fill actually landed — a stale value left over from a
      // previous run (a different member's number, say) would pass a mere
      // presence check silently. This must compare the live value against the
      // exact input this step was supposed to write.
      if (!match) return { ok: false, observed: `field ${c.name} not found` }
      const live = (match.value ?? '').trim()
      if (!live) return { ok: false, observed: `field ${c.name} found but empty` }
      const expected = (resolveInput?.(c.input) ?? '').trim()
      if (expected && live === expected) {
        return { ok: true, observed: `field ${c.name} holds the expected value` }
      }
      // Redacted the same way declared-sensitive values are redacted everywhere
      // else in this system: never print the raw value in a diagnostic message.
      return {
        ok: false,
        observed: `field ${c.name} holds ${redactValue(live, 'pii')}, expected ${redactValue(expected, 'pii')}`,
      }
    }
    // field-has-value: a node existing is not evidence anything was typed into it — the
    // field itself is on screen before and after a fill. This must check the node's
    // actual current value, or it can never fail while the control is merely present.
    if (!match) return { ok: false, observed: `field ${c.name} not found` }
    const hasValue = (match.value ?? '').trim().length > 0
    return {
      ok: hasValue,
      observed: hasValue ? `field ${c.name} present` : `field ${c.name} found but empty`,
    }
  }

  async readText(t: TargetDescriptor, budget?: Budget): Promise<string> {
    this.check('read', this.page.url())
    const obs = await this.observeBudgeted(budget)
    const frames = obs.frames.filter((f) => f.path.join('/') === t.framePath.join('/'))
    return frames.map((f) => f.text).join('\n')
  }

  async screenshot(path: string, mask: string[] = [], maskText: string[] = []): Promise<void> {
    this.check('read', this.page.url())
    const locators = [
      ...mask.map((sel) => this.page.locator(sel)),
      ...maskText.map((t) => this.page.getByText(t, { exact: false })),
    ]
    await this.page.screenshot({ path, fullPage: true, ...(locators.length ? { mask: locators } : {}) })
  }

  async domSnapshot(path: string): Promise<void> {
    this.check('read', this.page.url())
    await writeFile(path, await this.page.content(), 'utf8')
  }

  url(): string {
    return this.page.url()
  }

  /** The human's way into the live session. Deliberately NOT policy-gated the way agent
   *  actions are: a person who has been handed control is the authority, and in production
   *  they would be driving the real browser window, which no allowlist can intercept. It IS
   *  lease-gated, because two parties acting at once is the failure the lease exists to stop. */
  operatorHandle(): OperatorHandle {
    return {
      click: async (name: string): Promise<void> => {
        if (this.leaseHeld) throw new PolicyError('DENY', 'operator_acted_while_agent_holds_lease')
        const loc = this.page.getByRole('button', { name })
        const n = await loc.count()
        if (n !== 1) throw new Error(`operator click "${name}" matched ${n} controls, expected exactly 1`)
        await loc.click()
      },
      fill: async (name: string, value: string): Promise<void> => {
        if (this.leaseHeld) throw new PolicyError('DENY', 'operator_acted_while_agent_holds_lease')
        const loc = this.page.getByRole('textbox', { name })
        const n = await loc.count()
        if (n !== 1) throw new Error(`operator fill "${name}" matched ${n} controls, expected exactly 1`)
        await loc.fill(value)
      },
      navigate: async (url: string): Promise<void> => {
        if (this.leaseHeld) throw new PolicyError('DENY', 'operator_acted_while_agent_holds_lease')
        await this.page.goto(url, { waitUntil: 'domcontentloaded' })
      },
      url: () => this.page.url(),
    }
  }

  async close(): Promise<void> {
    await this.browser?.close()
  }
}
