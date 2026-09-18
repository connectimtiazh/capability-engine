import { describe, it, expect } from 'vitest'
import { classifyAction, isUrlAllowed, type PolicyConfig } from '../src/policy/allowlist.js'
import { gate } from '../src/policy/gate.js'
import { redactParams } from '../src/policy/redact.js'

const policy: PolicyConfig = {
  allowedOrigins: ['http://localhost:4000'],
  allowedPathPrefixes: ['/member', '/nav', '/'],
  allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
}

describe('classifyAction', () => {
  it('treats reading and navigating as read', () => {
    expect(classifyAction('read')).toBe('read')
    expect(classifyAction('navigate')).toBe('read')
    expect(classifyAction('waitFor')).toBe('read')
  })
  it('treats clicking and filling as mutate', () => {
    expect(classifyAction('click')).toBe('mutate')
    expect(classifyAction('fill')).toBe('mutate')
  })
})

describe('isUrlAllowed', () => {
  it('allows a listed origin and prefix', () => {
    expect(isUrlAllowed('http://localhost:4000/member/search', policy)).toBe(true)
  })
  it('rejects an unlisted origin', () => {
    expect(isUrlAllowed('http://evil.test/member/search', policy)).toBe(false)
  })
  it('rejects an unlisted path prefix', () => {
    expect(isUrlAllowed('http://localhost:4000/admin/wipe', { ...policy, allowedPathPrefixes: ['/member'] })).toBe(false)
  })
  it('does not let a prefix match a longer sibling path', () => {
    expect(isUrlAllowed('http://localhost:4000/membersecret', { ...policy, allowedPathPrefixes: ['/member'] })).toBe(false)
  })
  it('treats the root prefix as the root document only, not a wildcard', () => {
    expect(isUrlAllowed('http://localhost:4000/admin/wipe', { ...policy, allowedPathPrefixes: ['/'] })).toBe(false)
    expect(isUrlAllowed('http://localhost:4000/', { ...policy, allowedPathPrefixes: ['/'] })).toBe(true)
  })
})

describe('gate', () => {
  const base = { url: 'http://localhost:4000/member/search', policy, approvalState: 'approved' as const, leaseHeld: true }

  it('passes an allowed read', () => {
    expect(gate({ ...base, action: 'read' })).toEqual({ verdict: 'PASS' })
  })

  it('denies an action outside the allowlist', () => {
    expect(gate({ ...base, action: 'select' })).toMatchObject({ verdict: 'DENY', reason: expect.stringContaining('action_not_permitted') })
  })

  it('denies a url outside the allowlist', () => {
    expect(gate({ ...base, action: 'read', url: 'http://evil.test/x' })).toMatchObject({ verdict: 'DENY' })
  })

  it('holds a mutating action on a draft capability', () => {
    expect(gate({ ...base, action: 'click', approvalState: 'draft' })).toMatchObject({ verdict: 'HOLD', reason: expect.stringContaining('unapproved_mutation') })
  })

  it('passes a mutating action on an approved capability', () => {
    expect(gate({ ...base, action: 'click', approvalState: 'approved' })).toEqual({ verdict: 'PASS' })
  })

  it('denies any action when the lease is not held', () => {
    expect(gate({ ...base, action: 'read', leaseHeld: false })).toMatchObject({ verdict: 'DENY', reason: expect.stringContaining('lease_not_held') })
  })

  it('reads a draft capability without holding', () => {
    expect(gate({ ...base, action: 'read', approvalState: 'draft' })).toEqual({ verdict: 'PASS' })
  })
})

describe('redactParams', () => {
  const schema = {
    type: 'object' as const,
    required: ['memberId'],
    properties: {
      memberId: { type: 'string', 'x-sensitivity': 'pii' },
      branch: { type: 'string', 'x-sensitivity': 'safe' },
    },
  }

  it('hashes a pii field and leaves a safe field alone', () => {
    const out = redactParams({ memberId: '40021', branch: 'BKK' }, schema)
    expect(out.branch).toBe('BKK')
    expect(out.memberId).toMatch(/^sha256:[0-9a-f]{12}$/)
    expect(String(out.memberId)).not.toContain('40021')
  })

  it('redacts an unknown field conservatively', () => {
    const out = redactParams({ surprise: 'secret-value' }, schema)
    expect(out.surprise).toBe('[redacted]')
  })
})
