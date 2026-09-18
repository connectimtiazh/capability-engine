import { readFile } from 'node:fs/promises'
import type { ActionKind } from '../capability/schema.js'

export interface PolicyConfig {
  allowedOrigins: string[]
  allowedPathPrefixes: string[]
  allowedActions: ActionKind[]
}

/** Risk is derived from the action verb rather than hand-labelled per step, so a
 *  newly recorded step cannot arrive unclassified. Anything that can change server
 *  state is `mutate`; observation is `read`. */
const READ_ACTIONS = new Set<ActionKind>(['navigate', 'read', 'waitFor'])

export function classifyAction(a: ActionKind): 'read' | 'mutate' {
  return READ_ACTIONS.has(a) ? 'read' : 'mutate'
}

export function isUrlAllowed(url: string, cfg: PolicyConfig): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!cfg.allowedOrigins.includes(u.origin)) return false
  // Ruling F1: a prefix match must land on a path segment boundary. The root
  // prefix "/" matches only the root document, not every path (otherwise it
  // would make the path dimension of the allowlist vacuous), and a prefix like
  // "/member" must not match a longer sibling such as "/membersecret".
  return cfg.allowedPathPrefixes.some((p) => {
    if (p === '/') return u.pathname === '/'
    return u.pathname === p || u.pathname.startsWith(p.endsWith('/') ? p : p + '/')
  })
}

export async function loadPolicy(path = 'policy.json'): Promise<PolicyConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as PolicyConfig
}
