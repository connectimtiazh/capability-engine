import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright'
import { writeFile } from 'node:fs/promises'
import type { ActionKind, TargetDescriptor, Checkpoint } from '../capability/schema.js'
import { gate } from '../policy/gate.js'
import type { PolicyConfig } from '../policy/allowlist.js'
import { resolveDescriptor } from './resolver.js'
import { PolicyError, type A11yNode, type FrameSnapshot, type Observation, type Resolution } from './types.js'

export type { Observation, A11yNode, Resolution, FrameSnapshot } from './types.js'
export { PolicyError } from './types.js'

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
    const value = el.getAttribute('value') || ''
    const label = labelFor(el)
    const name =
      role === 'button' ? (value || el.textContent.trim())
      : role === 'link' ? el.textContent.trim()
      : role === 'table' ? (el.textContent.trim().slice(0, 40))
      : label
    el.setAttribute('data-cap-ref', 'n' + i)
    out.push({ role, name, nameAttr, labelText: label, ref: 'n' + (i++) })
  }
  return out
}`

export class WebSurface {
  private browser!: Browser
  private context!: BrowserContext
  private page!: Page
  private approvalState: 'draft' | 'approved' = 'draft'
  private leaseHeld = true

  constructor(private readonly policy: PolicyConfig, private readonly headless = false) {}

  setContext(c: { approvalState?: 'draft' | 'approved'; leaseHeld?: boolean }): void {
    if (c.approvalState) this.approvalState = c.approvalState
    if (c.leaseHeld !== undefined) this.leaseHeld = c.leaseHeld
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless })
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
  }

  /** Every action funnels through here. The gate lives inside the only module that
   *  can touch the surface, so neither discovery nor replay can route around it. */
  private check(action: ActionKind, url: string): void {
    const v = gate({ action, url, policy: this.policy, approvalState: this.approvalState, leaseHeld: this.leaseHeld })
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

  async open(url: string): Promise<void> {
    this.check('navigate', url)
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
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

  async resolve(t: TargetDescriptor): Promise<Resolution> {
    const obs = await this.observe()
    return resolveDescriptor(obs.frames.flatMap((f) => f.nodes), t)
  }

  private frameFor(path: string[]): Frame {
    const hit = this.frames().find((f) => f.path.join('/') === path.join('/'))
    return hit?.frame ?? this.page.mainFrame()
  }

  async act(action: ActionKind, node: A11yNode, value?: string): Promise<void> {
    this.check(action, this.page.url())
    const frame = this.frameFor(node.framePath)
    const loc = frame.locator(`[data-cap-ref="${node.ref}"]`)
    if (action === 'click') await loc.click()
    else if (action === 'fill') await loc.fill(value ?? '')
    else if (action === 'select') await loc.selectOption(value ?? '')
    else if (action === 'dismiss') await loc.click()
    else throw new Error(`act() cannot perform ${action}`)
  }

  async checkpointHolds(c: Checkpoint): Promise<{ ok: boolean; observed: string }> {
    const obs = await this.observe()
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
    const ok = nodes.some((n) => n.role === c.role && (n.name === c.name || n.labelText === c.name))
    return { ok, observed: ok ? `field ${c.name} present` : `field ${c.name} not found` }
  }

  async readText(t: TargetDescriptor): Promise<string> {
    this.check('read', this.page.url())
    const obs = await this.observe()
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

  async close(): Promise<void> {
    await this.browser?.close()
  }
}
