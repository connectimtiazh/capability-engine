import type { TargetDescriptor } from '../capability/schema.js'
import type { A11yNode, Resolution } from './types.js'

export type { A11yNode, Resolution } from './types.js'

const samePath = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function uniqueOrReport(matches: A11yNode[], via: string): Resolution | null {
  if (matches.length === 1) return { kind: 'one', node: matches[0]!, via }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
  return null
}

/** Resolve a descriptor to exactly one node, trying rungs in order and reporting
 *  which one fired. The `via` value is what makes drift measurable: a tenant that
 *  keeps resolving through `fallback[1]` is drifting away from the base recording.
 *
 *  Two or more matches is never an action. Picking the first of two candidate
 *  controls is how automation quietly operates on the wrong record. */
export function resolveDescriptor(nodes: A11yNode[], t: TargetDescriptor): Resolution {
  const inFrame = nodes.filter((n) => samePath(n.framePath, t.framePath))

  if (t.name) {
    const byName = inFrame.filter((n) => n.role === t.role && n.name === t.name)
    const r = uniqueOrReport(byName, 'primary')
    if (r) return r

    const byLabel = inFrame.filter((n) => n.role === t.role && n.labelText === t.name)
    const rl = uniqueOrReport(byLabel, 'labelText')
    if (rl) return rl
  }

  if (t.labelText) {
    const byLabel = inFrame.filter((n) => n.role === t.role && n.labelText === t.labelText)
    const r = uniqueOrReport(byLabel, 'labelText')
    if (r) return r
  }

  for (const [i, fb] of t.fallbacks.entries()) {
    let matches: A11yNode[] = []
    if (fb.strategy === 'name-attr') matches = inFrame.filter((n) => n.nameAttr === fb.value)
    else if (fb.strategy === 'link-text') matches = inFrame.filter((n) => n.role === 'link' && n.name === fb.value)
    else matches = inFrame.filter((n) => n.role === (fb.strategy === 'nth-submit-in-form' ? 'button' : 'textbox'))
        .slice(fb.index, fb.index + 1)

    const r = uniqueOrReport(matches, `fallback[${i}]:${fb.strategy}`)
    if (r) return r
  }

  return { kind: 'none' }
}
