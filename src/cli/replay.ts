import { replay } from '../replay/execute.js'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (v === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error(`missing --${name}`)
  }
  return v
}

async function main(): Promise<void> {
  let capability: string
  try {
    capability = arg('capability')
  } catch {
    console.log('usage: npm run replay -- --capability <ref> [--tenant <tenant>] [--params <json>]')
    process.exit(1)
  }

  const baseUrl = process.env.TARGET_APP_URL ?? 'http://localhost:4000'
  const inject = process.argv.indexOf('--inject')
  const entry = inject >= 0
    ? `${baseUrl}/member/search?inject=${process.argv[inject + 1]}`
    : undefined

  // --wait is the point of this whole task: a person has to be able to see and
  // drive the parked window, so it forces headful regardless of HEADLESS.
  const wait = process.argv.includes('--wait')

  const result = await replay({
    ref: capability,
    tenant: arg('tenant', 'firstvalley-cu'),
    params: JSON.parse(arg('params', '{}')) as Record<string, unknown>,
    storeRoot: 'store',
    headless: wait ? false : process.env.HEADLESS === '1',
    entryPointOverride: entry,
    waitForHuman: wait,
    onIntervention: wait
      ? async (iv) => {
          console.log(`  blocked: ${iv.id}  (${iv.reason} at ${iv.step})`)
          console.log('  the browser is open and waiting. do the step by hand, then:')
          console.log(`    npm run operator -- resume ${iv.id} --note "what you did"`)
        }
      : undefined,
  })

  console.log(JSON.stringify(result, null, 2))

  // Exit codes: 0 for success and business_outcome, 1 for failed, 2 for blocked
  // (a declared outcome is a legitimate answer, not an error; a blocked state
  // requires human intervention and is distinct from a failure)
  if (result.status === 'success' || result.status === 'business_outcome') {
    process.exitCode = 0
  } else if (result.status === 'failed') {
    process.exitCode = 1
  } else if (result.status === 'blocked') {
    process.exitCode = 2
  }
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
