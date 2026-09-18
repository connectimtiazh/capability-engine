import { FileStore } from '../capability/store.js'
import { buildCatalog } from '../catalog/catalog.js'
import { replay } from '../replay/execute.js'

const STORE = 'store'

async function main(): Promise<void> {
  const store = new FileStore(STORE)
  const [, , cmd, name] = process.argv

  if (cmd === 'invoke' && name) {
    const i = process.argv.indexOf('--args')
    const args = JSON.parse(i >= 0 ? (process.argv[i + 1] ?? '{}') : '{}') as Record<string, unknown>
    const tool = (await buildCatalog(store)).find((t) => t.name === name || t.ref.startsWith(name))
    if (!tool) throw new Error(`no capability named ${name}`)
    // A draft has not earned unattended invocation (see src/catalog/catalog.ts). At a
    // CLI a human is present by construction, so we warn on stderr and proceed rather
    // than block — the warning is the gate. An unattended production caller (an agent
    // invoking this catalog with no human watching) must not make the same call: it
    // should refuse a non-`unattended` tool outright instead of warning and continuing.
    if (!tool.unattended) console.error(`note: ${tool.ref} is a draft — attended invocation only`)
    const result = await replay({
      ref: tool.ref, tenant: 'firstvalley-cu', params: args, storeRoot: STORE,
      headless: process.env.HEADLESS === '1',
    })
    console.log(JSON.stringify(result, null, 2))

    // Exit codes match src/cli/replay.ts: 0 for success and business_outcome, 1 for
    // failed, 2 for blocked (a declared outcome is a legitimate answer, not an error;
    // a blocked state requires human intervention and is distinct from a failure).
    if (result.status === 'success' || result.status === 'business_outcome') {
      process.exitCode = 0
    } else if (result.status === 'failed') {
      process.exitCode = 1
    } else if (result.status === 'blocked') {
      process.exitCode = 2
    }
    return
  }

  console.log(JSON.stringify(await buildCatalog(store), null, 2))
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
