// Dispatcher behind every `npm run demo:<name>` one-liner. Each named script in
// package.json is just `tsx scripts/demo-run.ts <name>` — the actual command and
// the pass/fail check live once, in scripts/demo/registry.ts, shared with
// `npm run demo` so the two never drift apart.
//
// Requires the target app running (`npm run target-app`) except for `catalog`,
// which only reads store/capabilities.

import { demos } from './demo/registry.js'

async function main(): Promise<void> {
  const name = process.argv[2]
  const demo = name ? demos[name] : undefined
  if (!demo) {
    console.error(`usage: tsx scripts/demo-run.ts <${Object.keys(demos).join('|')}>`)
    process.exitCode = 1
    return
  }

  console.log(`\n${demo.heading}\n${'-'.repeat(demo.heading.length)}`)
  const outcome = await demo.run()
  console.log(`\n${outcome.ok ? 'OK' : 'MISMATCH'}  ${name}  ${outcome.verdictText}`)
  process.exitCode = outcome.ok ? 0 : 1
}

main().catch((e) => {
  console.error(String(e))
  process.exitCode = 1
})
