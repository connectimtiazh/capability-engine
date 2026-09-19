// Presentation-only helpers shared by the named `demo:*` npm scripts and the
// `npm run demo` orchestrator. Nothing here touches engine behaviour: each helper
// just shells out to the same CLIs a user would type by hand
// (`src/cli/replay.ts`, `src/cli/catalog.ts`), using `node` + the local `tsx`
// loader directly (not `npx`/`npm run`) so it works identically on Windows and
// POSIX without a shell in the middle.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
export const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

export interface RunOutcome {
  ok: boolean
  verdictText: string
  parsed: unknown
  exitCode: number | null
}

function runCli(cliRelPath: string, args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [TSX_CLI, path.join(ROOT, cliRelPath), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

/** Runs `src/cli/replay.ts`, prints exactly what someone typing the long form
 *  would see, and checks the parsed JSON result against what this demo is
 *  supposed to prove. */
export function demoReplay(
  args: string[],
  check: (parsed: any) => boolean,
  verdict: (parsed: any) => string,
  env: NodeJS.ProcessEnv = {},
): RunOutcome {
  const { stdout, stderr } = runCli('src/cli/replay.ts', args, env)
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n')
  if (stderr) process.stderr.write(stderr)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    parsed = null
  }
  const ok = parsed !== null && check(parsed)
  return { ok, verdictText: parsed !== null ? verdict(parsed) : '(no parsable JSON on stdout)', parsed, exitCode: null }
}

export function demoCatalog(): RunOutcome {
  const { stdout, stderr } = runCli('src/cli/catalog.ts', [])
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n')
  if (stderr) process.stderr.write(stderr)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    parsed = null
  }
  const ok = Array.isArray(parsed) && parsed.length > 0
  const verdictText = Array.isArray(parsed)
    ? `${parsed.length} capabilities catalogued (${parsed.filter((t: any) => t.unattended).length} unattended)`
    : '(no parsable JSON on stdout)'
  return { ok, verdictText, parsed, exitCode: null }
}
