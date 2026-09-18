import type { ActionKind } from '../capability/schema.js'
import { classifyAction, isUrlAllowed, type PolicyConfig } from './allowlist.js'

export interface GateRequest {
  action: ActionKind
  url: string
  policy: PolicyConfig
  approvalState: 'draft' | 'approved'
  leaseHeld: boolean
}

export type GateVerdict =
  | { verdict: 'PASS' }
  | { verdict: 'HOLD'; reason: string }
  | { verdict: 'DENY'; reason: string }

/** Three states, deterministic inputs.
 *
 *  HOLD is not a failure — it is a decision a human owes us, so it routes to the
 *  intervention queue rather than to an error. DENY is a refusal: nothing a human
 *  can say at this moment makes it permissible, because it is outside the
 *  configured allowlist.
 *
 *  Note what is NOT an input: model confidence. A safety gate keyed on a
 *  self-reported score is a probabilistic guardrail, which is a contradiction. */
export function gate(req: GateRequest): GateVerdict {
  if (!req.leaseHeld) return { verdict: 'DENY', reason: 'lease_not_held' }

  if (!req.policy.allowedActions.includes(req.action)) {
    return { verdict: 'DENY', reason: `action_not_permitted:${req.action}` }
  }

  if (!isUrlAllowed(req.url, req.policy)) {
    return { verdict: 'DENY', reason: `url_not_permitted:${req.url}` }
  }

  if (classifyAction(req.action) === 'mutate' && req.approvalState === 'draft') {
    return { verdict: 'HOLD', reason: `unapproved_mutation:${req.action}` }
  }

  return { verdict: 'PASS' }
}
