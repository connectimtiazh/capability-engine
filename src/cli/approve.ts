import { FileStore } from '../capability/store.js'

/** Promotes a capability from draft to approved. Approval is a human act: it is what lets a
 *  capability's mutating steps run unattended, so it is recorded on the artifact itself
 *  alongside the replay history that justifies it. */
async function main(): Promise<void> {
  const ref = process.argv[2]
  if (!ref) {
    console.log('usage: npm run approve -- <key>@<version> [--by <who>]')
    process.exitCode = 1
    return
  }
  const i = process.argv.indexOf('--by')
  const by = i >= 0 ? (process.argv[i + 1] ?? 'operator:local') : 'operator:local'

  const store = new FileStore('store')
  const c = await store.loadCapability(ref)
  c.approval.state = 'approved'
  c.approval.approvedBy = by
  c.provenance.humanEdits.push({ at: new Date().toISOString(), by, note: 'approved for unattended replay' })
  await store.saveCapability(c)
  console.log(`approved ${ref} (by ${by}); replayStats:`, JSON.stringify(c.approval.replayStats))
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
