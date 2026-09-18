import { InterventionStore } from '../control/interventions.js'

const STORE = 'store'

async function main(): Promise<void> {
  const [, , cmd, id] = process.argv
  const store = new InterventionStore(STORE)

  if (cmd === 'list') {
    const all = await store.list()
    if (!all.length) { console.log('no interventions'); return }
    for (const iv of all) {
      console.log(`${iv.state === 'open' ? '[OPEN]' : '[done]'} ${iv.id}  ${iv.capability}  step=${iv.step}  reason=${iv.reason}`)
      if (iv.state === 'open') console.log(`        evidence: ${iv.evidenceDir}`)
    }
    return
  }

  if (cmd === 'show' && id) {
    console.log(JSON.stringify(await store.get(id), null, 2))
    return
  }

  if (cmd === 'resume' && id) {
    const i = process.argv.indexOf('--note')
    const note = i >= 0 ? (process.argv[i + 1] ?? '') : ''
    // The live run is watching this file. It re-acquires the lease, re-asserts the
    // parked step's checkpoint against the real page, and only then continues.
    await store.resolve(id, note)
    console.log(`resumed ${id}${note ? ` (${note})` : ''}`)
    return
  }

  console.log('usage: npm run operator -- list | show <id> | resume <id> [--note "..."]')
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
