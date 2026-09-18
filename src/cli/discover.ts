import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runDiscovery } from '../discover/loop.js'
import { OpenRouterModel } from '../discover/model.js'
import { compile } from '../compile/compile.js'
import { FileStore } from '../capability/store.js'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (v === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error(`missing --${name}`)
  }
  return v
}

const STORE = 'store'

async function main(): Promise<void> {
  const goal = arg('goal')
  const entry = arg('entry', 'http://localhost:4000/member/search')
  const key = arg('key', 'quest-core/member.savings_balance')
  const params = JSON.parse(arg('params', '{}')) as Record<string, string>

  const trace = await runDiscovery({
    goal, entryPoint: entry, model: new OpenRouterModel(),
    storeRoot: STORE, headless: process.env.HEADLESS === '1', maxSteps: 15,
    params,
  })

  await mkdir(join(STORE, 'runs', trace.runId), { recursive: true })
  await writeFile(join(STORE, 'runs', trace.runId, 'trace.json'), JSON.stringify(trace, null, 2), 'utf8')

  const capability = compile(trace, { key, params })
  await new FileStore(STORE).saveCapability(capability)

  console.log(`discovery ok  run=${trace.runId}  steps=${trace.steps.length}`)
  console.log(`capability    ${capability.key}@${capability.version}`)
  console.log(`evidence      ${join(STORE, 'runs', trace.runId)}`)
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
