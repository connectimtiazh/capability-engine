import { FileStore } from '../capability/store.js'

/** Promotes a capability from draft to approved. Approval is a human act: it is what lets a
 *  capability's mutating steps run unattended, so it is recorded on the artifact itself
 *  alongside the replay history that justifies it. */
const BUSINESS_RISKS = ['read', 'mutation', 'irreversible'] as const
type BusinessRisk = (typeof BUSINESS_RISKS)[number]

async function main(): Promise<void> {
  const ref = process.argv[2]
  if (!ref) {
    console.log('usage: npm run approve -- <key>@<version> [--by <who>] [--business-risk <read|mutation|irreversible>]')
    process.exitCode = 1
    return
  }
  const i = process.argv.indexOf('--by')
  const by = i >= 0 ? (process.argv[i + 1] ?? 'operator:local') : 'operator:local'

  const bi = process.argv.indexOf('--business-risk')
  let businessRisk: BusinessRisk | undefined
  if (bi >= 0) {
    const v = process.argv[bi + 1]
    if (!v || !BUSINESS_RISKS.includes(v as BusinessRisk)) {
      console.log(`--business-risk must be one of: ${BUSINESS_RISKS.join(', ')}`)
      process.exitCode = 1
      return
    }
    businessRisk = v as BusinessRisk
  }

  const store = new FileStore('store')
  const c = await store.loadCapability(ref)
  c.approval.state = 'approved'
  c.approval.approvedBy = by
  c.provenance.humanEdits.push({ at: new Date().toISOString(), by, note: 'approved for unattended replay' })

  // Setting the business risk here is a human taking responsibility for that
  // claim — the only way risk.businessSetBy ever becomes 'human-confirmed', and
  // the only way an irreversible capability's mutations can pass the gate
  // unattended (see src/policy/gate.ts).
  if (businessRisk) {
    c.risk.business = businessRisk
    c.risk.businessSetBy = 'human-confirmed'
    c.provenance.humanEdits.push({ at: new Date().toISOString(), by, note: `confirmed business risk: ${businessRisk}` })
  }

  await store.saveCapability(c)
  console.log(`approved ${ref} (by ${by}); business=${c.risk.business}/${c.risk.businessSetBy}; replayStats:`, JSON.stringify(c.approval.replayStats))
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
