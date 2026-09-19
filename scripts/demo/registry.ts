// Single source of truth for every named demo, so `npm run demo:<x>` and the
// `npm run demo` golden-path orchestrator run exactly the same command and
// exactly the same pass/fail check. Order here is the golden-path order.

import { demoReplay, demoCatalog, type RunOutcome } from './lib.js'
import { runStepTimeoutDemo } from './step-timeout.js'

export interface Demo {
  heading: string
  run: () => RunOutcome | Promise<RunOutcome>
}

const CAP = 'quest-core/member.savings_balance@1.0.0'

export const demos: Record<string, Demo> = {
  success: {
    heading: 'demo:success — member 40021, straight read',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"40021"}'],
        (p) => p.status === 'success' && p.outputs?.savingsBalance === 1284.55,
        (p) => `success  savingsBalance=${p.outputs?.savingsBalance}`,
        { HEADLESS: '1' },
      ),
  },

  'cross-member': {
    heading: 'demo:cross-member — same capability, member 40023 (parameterisation proof)',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"40023"}'],
        (p) => p.status === 'success' && p.outputs?.savingsBalance === 312,
        (p) => `success  savingsBalance=${p.outputs?.savingsBalance} — member 40023's own balance, not 40021's`,
        { HEADLESS: '1' },
      ),
  },

  'not-found': {
    heading: 'demo:not-found — member 99999, a declared business outcome',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"99999"}'],
        (p) => p.status === 'business_outcome' && p.code === 'MEMBER_NOT_FOUND',
        (p) => `business_outcome  ${p.code}`,
        { HEADLESS: '1' },
      ),
  },

  restricted: {
    heading: 'demo:restricted — member 40022, a second declared outcome',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"40022"}'],
        (p) => p.status === 'business_outcome' && p.code === 'ACCOUNT_RESTRICTED',
        (p) => `business_outcome  ${p.code}`,
        { HEADLESS: '1' },
      ),
  },

  'session-timeout': {
    heading: 'demo:session-timeout — injected session expiry, recovers and completes',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"40021"}', '--inject', 'session-timeout'],
        (p) => p.status === 'success' && p.outputs?.savingsBalance === 1284.55,
        (p) => `success  savingsBalance=${p.outputs?.savingsBalance} (recovered from session-timeout, did not just wait it out)`,
        { HEADLESS: '1' },
      ),
  },

  blocked: {
    heading: 'demo:blocked — injected unrecognised dialog, stops rather than guesses',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"40021"}', '--inject', 'unknown-dialog'],
        (p) => p.status === 'blocked' && p.reason === 'unrecognised_state_or_missing_control',
        (p) => `blocked  ${p.reason}  interventionId=${p.interventionId}`,
        { HEADLESS: '1' },
      ),
  },

  'step-timeout': {
    heading: 'demo:step-timeout — tight per-step budget against a slow response',
    run: () => runStepTimeoutDemo(),
  },

  frameset: {
    heading: 'demo:frameset — entry at / (the frameset shell), correctly refuses',
    run: () =>
      demoReplay(
        ['--capability', CAP, '--params', '{"memberId":"40021"}', '--entry', 'http://localhost:4000/'],
        (p) => p.status === 'blocked' && p.reason === 'unrecognised_state_or_missing_control',
        (p) => `blocked  ${p.reason} — frameset reached; this capability's steps carry framePath: [] so it does not follow into "main"`,
        { HEADLESS: '1' },
      ),
  },

  catalog: {
    heading: 'demo:catalog — every saved capability as a callable tool definition',
    run: () => demoCatalog(),
  },
}

export const ORDER: string[] = [
  'success',
  'cross-member',
  'not-found',
  'restricted',
  'session-timeout',
  'blocked',
  'step-timeout',
  'frameset',
  'catalog',
]
