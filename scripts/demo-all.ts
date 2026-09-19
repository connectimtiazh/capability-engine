// `npm run demo` — the whole golden path in one command, needing no API key.
//
// 1. Checks whether the target app is already answering on TARGET_APP_URL
//    (default http://localhost:4000). If so, reuses it and leaves it running
//    (it isn't ours to kill).
// 2. Otherwise starts it (`node` + the local `tsx` loader directly, not
//    `npx`/`npm run`, so this works the same on Windows and POSIX with no shell
//    in between) and waits for it to answer. If the port is already held by
//    something else, or the app never comes up, this says so and exits — it
//    does not hang.
// 3. Runs every demo in scripts/demo/registry.ts in golden-path order, printing
//    a heading before each and a one-line OK/MISMATCH verdict after.
// 4. Shuts the target app back down if (and only if) this script started it.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import path from 'node:path'
import { ROOT, TSX_CLI } from './demo/lib.js'
import { demos, ORDER } from './demo/registry.js'

const TARGET_APP_URL = process.env.TARGET_APP_URL ?? 'http://localhost:4000'
const HEALTH_PATH = '/member/search'
const READY_TIMEOUT_MS = 15_000
// Every page this app serves goes through the same `chrome()` wrapper, so this
// string is on every response — including error pages. A plain "did something
// answer on port 4000" check would happily treat an unrelated process squatting
// the port as "already running" and then spend a full demo run failing against
// it instead of saying so up front.
const TARGET_APP_MARKER = 'QuestCore Member Services'

type Probe = 'up' | 'down' | 'occupied'

async function probe(timeoutMs = 800): Promise<Probe> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${TARGET_APP_URL}${HEALTH_PATH}`, { signal: ctrl.signal })
    if (res.status >= 500) return 'occupied'
    const body = await res.text()
    return body.includes(TARGET_APP_MARKER) ? 'up' : 'occupied'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

type StartOutcome = 'up' | 'port-in-use' | 'timeout'

function waitForStart(child: ChildProcessWithoutNullStreams): Promise<StartOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let sawAddrInUse = false
    const settle = (outcome: StartOutcome) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      resolve(outcome)
    }
    child.stdout.on('data', (d: Buffer) => process.stdout.write(d))
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      process.stderr.write(text)
      if (text.includes('EADDRINUSE')) sawAddrInUse = true
    })
    child.on('exit', () => {
      if (!settled) settle(sawAddrInUse ? 'port-in-use' : 'timeout')
    })
    const deadline = Date.now() + READY_TIMEOUT_MS
    const poll = setInterval(() => {
      void (async () => {
        if (sawAddrInUse) return settle('port-in-use')
        const result = await probe(500)
        if (result === 'up') return settle('up')
        if (result === 'occupied') return settle('port-in-use')
        if (Date.now() > deadline) return settle('timeout')
      })()
    }, 300)
  })
}

async function main(): Promise<void> {
  let child: ChildProcessWithoutNullStreams | undefined
  let startedByUs = false

  console.log(`checking for the target app at ${TARGET_APP_URL} ...`)
  const initial = await probe()
  if (initial === 'occupied') {
    console.error(
      `\nport 4000 is already in use, but it is not answering ${HEALTH_PATH} as this target app does.\n` +
        'Stop whatever is holding that port and re-run "npm run demo".',
    )
    process.exitCode = 1
    return
  }
  if (initial === 'up') {
    console.log('already running — reusing it.')
  } else {
    console.log('not running — starting it (npm run target-app) ...')
    child = spawn(process.execPath, [TSX_CLI, path.join(ROOT, 'target-app/server.ts')], {
      cwd: ROOT,
      env: process.env,
    }) as ChildProcessWithoutNullStreams

    const outcome = await waitForStart(child)
    if (outcome === 'port-in-use') {
      console.error(
        `\nport 4000 is already in use by something that is not answering ${HEALTH_PATH} correctly.\n` +
          'Stop whatever is holding that port and re-run "npm run demo".',
      )
      child.kill()
      process.exitCode = 1
      return
    }
    if (outcome === 'timeout') {
      console.error(`\ntarget app did not become ready within ${READY_TIMEOUT_MS}ms. Exiting rather than hang.`)
      child.kill()
      process.exitCode = 1
      return
    }
    startedByUs = true
    console.log('target app is up.')
  }

  let allOk = true
  try {
    for (const name of ORDER) {
      const demo = demos[name]
      if (!demo) throw new Error(`registry.ts ORDER references unknown demo "${name}"`)
      console.log(`\n${'='.repeat(78)}\n${demo.heading}\n${'='.repeat(78)}`)
      const outcome = await demo.run()
      console.log(`\n${outcome.ok ? 'OK' : 'MISMATCH'}  ${name}  ${outcome.verdictText}`)
      if (!outcome.ok) allOk = false
    }
  } finally {
    if (startedByUs && child) {
      console.log('\nshutting down the target app ...')
      child.kill()
    }
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log(allOk ? 'demo: all steps matched their expected outcome' : 'demo: one or more steps did NOT match — see MISMATCH lines above')
  process.exitCode = allOk ? 0 : 1
}

main().catch((e) => {
  console.error(String(e))
  process.exitCode = 1
})
