// `demo:step-timeout` needs a tighter budget than the shipped capability carries
// (s2.timeoutMs is 8000; `--inject slow-inquire` only delays the response by 3s).
// Rather than ask a reviewer to hand-edit the committed artifact and remember to
// put it back (the pattern the README documents for this exact case), this
// script does the edit itself, runs the demo, and restores the original bytes
// in a `finally` — so the artifact on disk is byte-identical before and after,
// whether the run succeeds or throws.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT, demoReplay, type RunOutcome } from './lib.js'

const CAPABILITY_PATH = path.join(
  ROOT,
  'store/capabilities/quest-core/member.savings_balance/1.0.0.json',
)

export async function runStepTimeoutDemo(): Promise<RunOutcome> {
  const original = readFileSync(CAPABILITY_PATH, 'utf8')
  const capability = JSON.parse(original) as {
    steps: Array<{ id: string; timeoutMs: number; onError: Array<{ when: string; max?: number }> }>
  }
  const s2 = capability.steps.find((s) => s.id === 's2')
  if (!s2) throw new Error('s2 not found in capability — cannot wire the step-timeout demo')
  const timeoutRung = s2.onError.find((e) => e.when === 'timeout')
  if (!timeoutRung) throw new Error('s2 has no timeout recovery rung — cannot wire the step-timeout demo')

  s2.timeoutMs = 1000
  timeoutRung.max = 1
  writeFileSync(CAPABILITY_PATH, JSON.stringify(capability, null, 2) + '\n')

  try {
    return demoReplay(
      [
        '--capability', 'quest-core/member.savings_balance@1.0.0',
        '--params', '{"memberId":"40021"}',
        '--inject', 'slow-inquire',
      ],
      (p) => p.status === 'failed' && p.class === 'step_timeout',
      (p) => `failed / step_timeout at ${p.step} (budget tightened to 1000ms for this run only, then restored)`,
      { HEADLESS: '1' },
    )
  } finally {
    writeFileSync(CAPABILITY_PATH, original)
  }
}

const isMain = process.argv[1]?.endsWith('step-timeout.ts')
if (isMain) {
  runStepTimeoutDemo().then((outcome) => {
    console.log(`\n${outcome.ok ? 'OK' : 'MISMATCH'}  step-timeout  ${outcome.verdictText}`)
    process.exitCode = outcome.ok ? 0 : 1
  })
}
