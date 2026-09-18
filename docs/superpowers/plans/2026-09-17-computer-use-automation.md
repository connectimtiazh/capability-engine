# Computer-Use Automation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a system where an LLM discovers how to complete a goal in a legacy web app once, compiles that run into a typed versioned capability artifact, and then replays the artifact deterministically with no model in the decision loop — with a safety gate, a four-way result contract, human escalation over the same live browser session, and evidence for every run.

**Architecture:** Single Node process, files on disk. A `Surface` interface is the only thing that knows about Playwright; everything above it speaks in accessibility roles, names and text. Discovery (model present) produces a Trace; a compiler turns the Trace into a Capability; replay executes the Capability with a throwing `ModelClient` injected to prove the model is absent. One policy gate lives inside the surface module so neither path can route around it.

**Tech Stack:** TypeScript 5.x (run via `tsx`, no build step), Playwright, zod, vitest, Express (target app only), Node 22.

**Spec:** `docs/superpowers/specs/2026-09-17-computer-use-automation-design.md`

## Global Constraints

- Node 22.x; TypeScript run through `tsx`, no compile step, no `dist/`.
- `replay/**` must never import from `discover/**` or `**/model*`. Enforced by a test in Task 10.
- Only `src/surface/web.ts` may import `playwright`. Enforced by the same test.
- No secrets in any committed file. `.env` is gitignored; `store/bindings/**` uses `env:`/`vault:` refs only.
- Every artifact carries `apiVersion: "capability/v1"` and a semver `version`.
- All timestamps ISO-8601 UTC with `Z`.
- Result status strings are exactly: `success` | `business_outcome` | `blocked` | `failed`.
- Gate verdicts are exactly: `PASS` | `HOLD` | `DENY`.
- Sensitivity classes are exactly: `pii` | `secret` | `safe`.
- No `sleep`/fixed delays in replay — waits are conditions with deadlines.
- Commit after every task.

---

## File Structure

| Path | Responsibility |
|---|---|
| `target-app/server.ts` | Hostile legacy bank UI: framesets, layout tables, no test IDs |
| `target-app/data.ts` | In-memory members; drives found / not-found / restricted |
| `src/types.ts` | Shared primitive types used by more than one module |
| `src/capability/schema.ts` | zod schemas for Capability, Binding, Step, Target, Checkpoint, Result |
| `src/capability/store.ts` | `Store` interface + file backend; capability/binding resolution |
| `src/surface/types.ts` | `Surface`, `Observation`, `TargetDescriptor`, `Action`, `Resolution` |
| `src/surface/resolver.ts` | Descriptor → exactly-one handle; resolver ladder + drift record |
| `src/surface/web.ts` | Playwright `WebSurface`; calls the policy gate before every act |
| `src/policy/allowlist.ts` | Origin/route allowlist + verb→risk classification |
| `src/policy/gate.ts` | PASS / HOLD / DENY on deterministic inputs |
| `src/policy/redact.ts` | Redaction by declared sensitivity class |
| `src/evidence/recorder.ts` | JSONL timeline, screenshots, DOM snapshots |
| `src/control/lease.ts` | Control lease with fencing token |
| `src/control/interventions.ts` | Intervention queue read/write |
| `src/discover/model.ts` | `ModelClient` interface + OpenRouter implementation |
| `src/discover/prompt.ts` | System prompt + observation serialisation |
| `src/discover/loop.ts` | observe → decide → act; emits a `Trace` |
| `src/compile/compile.ts` | `Trace` → `Capability` |
| `src/replay/outcomes.ts` | Checkpoint + business-outcome detector matching |
| `src/replay/recovery.ts` | Recoverable-condition rungs |
| `src/replay/execute.ts` | Deterministic executor, four-way result |
| `src/catalog/catalog.ts` | Capabilities → callable tool definitions |
| `src/cli/*.ts` | `discover`, `replay`, `operator`, `catalog` entry points |
| `tests/**` | vitest |

**Ordering rationale:** Tasks 1–2 build the surface to point a model at. Task 3–6 get to a **real LLM discovery run by Task 6** — the one thing the brief says cannot be faked. Everything after hardens. If time runs out after Task 9 the submission is still complete against every core requirement.

---

### Task 1: Project scaffolding + the hostile target app

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `target-app/data.ts`, `target-app/server.ts`
- Test: `tests/target-app.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an HTTP server on `:4000`. Routes: `GET /` (frameset), `GET /nav`, `GET /member/search`, `POST /member/inquire`, `GET /health`. Query flags `?inject=motd|session-timeout|unknown-dialog|slow` force conditions. Members: `40021` (found, balance 1284.55), `40022` (restricted), anything else (not found).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "interface-capability-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "target-app": "tsx target-app/server.ts",
    "discover": "tsx src/cli/discover.ts",
    "replay": "tsx src/cli/replay.ts",
    "operator": "tsx src/cli/operator.ts",
    "catalog": "tsx src/cli/catalog.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.19.2",
    "playwright": "^1.47.0",
    "zod": "^3.23.8",
    "zod-to-json-schema": "^3.23.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*", "target-app/**/*", "tests/**/*"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', testTimeout: 30_000, hookTimeout: 30_000 },
})
```

`.gitignore`:
```
node_modules/
.env
store/runs/
store/control/
store/interventions/
*.log
```

`.env.example`:
```
OPENROUTER_API_KEY=sk-or-...
DISCOVERY_MODEL=anthropic/claude-opus-4.1
TARGET_APP_URL=http://localhost:4000
```

- [ ] **Step 3: Install dependencies**

```bash
npm install
npx playwright install chromium
```

- [ ] **Step 4: Write the failing test**

Create `tests/target-app.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../target-app/server.js'

let server: Server
const base = 'http://localhost:4111'

beforeAll(async () => {
  server = createServer().listen(4111)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

describe('hostile target app', () => {
  it('serves a frameset at the root with a main frame', async () => {
    const html = await (await fetch(base + '/')).text()
    expect(html).toContain('<frameset')
    expect(html).toContain('name="main"')
  })

  it('renders the search form with no ids and no test ids', async () => {
    const html = await (await fetch(base + '/member/search')).text()
    expect(html).toContain('ctl00$mbrNo')
    expect(html).not.toMatch(/data-testid/)
    expect(html).not.toMatch(/\bid="/)
    expect(html).toContain('<table')
  })

  it('returns a balance for a known member', async () => {
    const res = await fetch(base + '/member/inquire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ctl00%24mbrNo=40021',
    })
    const html = await res.text()
    expect(html).toContain('Share Balance')
    expect(html).toContain('1284.55')
  })

  it('says no record found for an unknown member', async () => {
    const res = await fetch(base + '/member/inquire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ctl00%24mbrNo=99999',
    })
    expect(await res.text()).toContain('No record found')
  })

  it('says access restricted for a restricted member', async () => {
    const res = await fetch(base + '/member/inquire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ctl00%24mbrNo=40022',
    })
    expect(await res.text()).toContain('Access restricted')
  })

  it('injects a session timeout when asked', async () => {
    const res = await fetch(base + '/member/search?inject=session-timeout')
    expect(await res.text()).toContain('Your session has expired')
  })

  it('injects an unknown dialog when asked', async () => {
    const res = await fetch(base + '/member/search?inject=unknown-dialog')
    expect(await res.text()).toContain('Compliance Notice')
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/target-app.test.ts`
Expected: FAIL — cannot resolve `../target-app/server.js`.

- [ ] **Step 6: Write `target-app/data.ts`**

```ts
export interface Member {
  memberId: string
  name: string
  savingsBalance: number
  restricted: boolean
}

const MEMBERS: Member[] = [
  { memberId: '40021', name: 'A. Whitfield', savingsBalance: 1284.55, restricted: false },
  { memberId: '40022', name: 'R. Delacroix', savingsBalance: 9902.10, restricted: true },
  { memberId: '40023', name: 'M. Okonkwo', savingsBalance: 312.00, restricted: false },
]

export type Lookup =
  | { kind: 'found'; member: Member }
  | { kind: 'restricted' }
  | { kind: 'not_found' }

export function lookup(memberId: string): Lookup {
  const m = MEMBERS.find((x) => x.memberId === memberId)
  if (!m) return { kind: 'not_found' }
  if (m.restricted) return { kind: 'restricted' }
  return { kind: 'found', member: m }
}

export const AS_OF = '2026-09-17'
```

- [ ] **Step 7: Write `target-app/server.ts`**

Deliberately hostile: frameset, layout tables, `<font>`, ASP-style control names, no `id`, no `data-testid`.

```ts
import express from 'express'
import type { Server } from 'node:http'
import { lookup, AS_OF } from './data.js'

type Inject = 'motd' | 'session-timeout' | 'unknown-dialog' | 'slow' | undefined

const chrome = (body: string) => `<html><head><title>QuestCore 8.3</title></head>
<body bgcolor="#EFEFEF"><table width="100%" cellpadding="4" cellspacing="0" border="0">
<tr><td bgcolor="#1F3A5F"><font color="#FFFFFF" size="2"><b>QuestCore Member Services 8.3</b></font></td></tr>
<tr><td>${body}</td></tr></table></body></html>`

const dialog = (title: string, text: string) => `
<table border="1" cellpadding="8" cellspacing="0" bgcolor="#FFFFCC" width="420">
  <tr><td><font size="2"><b>${title}</b></font></td></tr>
  <tr><td><font size="2">${text}</font></td></tr>
  <tr><td><form method="get" action="/member/search">
    <input type="submit" value="Acknowledge"></form></td></tr>
</table>`

const searchForm = `
<form method="post" action="/member/inquire">
<table cellpadding="3" cellspacing="0" border="0">
  <tr>
    <td nowrap><font size="2">Member No.</font></td>
    <td><input type="text" name="ctl00$mbrNo" size="12"></td>
    <td><input type="submit" name="ctl00$btnInquire" value="Inquire"></td>
  </tr>
  <tr><td colspan="3"><font size="1" color="#666666">Enter a member number and select Inquire.</font></td></tr>
</table>
</form>`

export function createServer(): Server {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

  app.get('/health', (_req, res) => { res.json({ ok: true }) })

  app.get('/', (_req, res) => {
    res.type('html').send(`<html><head><title>QuestCore 8.3</title></head>
<frameset rows="70,*" border="1">
  <frame src="/nav" name="nav">
  <frame src="/member/search" name="main">
</frameset></html>`)
  })

  app.get('/nav', (_req, res) => {
    res.type('html').send(chrome(`<font size="2">Member Services &nbsp;|&nbsp; Teller &nbsp;|&nbsp; Reports</font>`))
  })

  app.get('/member/search', async (req, res) => {
    const inject = req.query.inject as Inject
    if (inject === 'slow') await new Promise((r) => setTimeout(r, 3000))
    if (inject === 'session-timeout') {
      return res.type('html').send(chrome(
        `<font size="2" color="#AA0000"><b>Your session has expired.</b></font>
         <br><form method="get" action="/member/search"><input type="submit" value="Sign in again"></form>`))
    }
    if (inject === 'motd') {
      return res.type('html').send(chrome(dialog('Message of the Day', 'Scheduled maintenance Sunday 02:00-04:00 ET.')))
    }
    if (inject === 'unknown-dialog') {
      return res.type('html').send(chrome(dialog('Compliance Notice', 'Quarterly attestation is now due for this workstation.')))
    }
    res.type('html').send(chrome(searchForm))
  })

  app.post('/member/inquire', (req, res) => {
    const raw = (req.body['ctl00$mbrNo'] ?? '') as string
    const memberId = raw.trim()
    const result = lookup(memberId)

    if (result.kind === 'not_found') {
      return res.type('html').send(chrome(
        `<font size="2" color="#AA0000"><b>No record found</b></font><br><br>${searchForm}`))
    }
    if (result.kind === 'restricted') {
      return res.type('html').send(chrome(
        `<font size="2" color="#AA0000"><b>Access restricted</b></font>
         <br><font size="1">This member requires elevated entitlements.</font><br><br>${searchForm}`))
    }

    const m = result.member
    res.type('html').send(chrome(`
<table cellpadding="3" cellspacing="0" border="0">
  <tr><td nowrap><font size="2">Member</font></td><td><font size="2">${m.name} (${m.memberId})</font></td></tr>
  <tr><td nowrap><font size="2">Share Balance</font></td><td><font size="2">${m.savingsBalance.toFixed(2)}</font></td></tr>
  <tr><td nowrap><font size="2">As Of</font></td><td><font size="2">${AS_OF}</font></td></tr>
</table><br>${searchForm}`))
  })

  return app as unknown as Server & express.Express
}

const isMain = process.argv[1]?.endsWith('server.ts')
if (isMain) {
  const port = Number(process.env.PORT ?? 4000)
  ;(createServer() as unknown as express.Express).listen(port, () => {
    console.log(`target-app listening on http://localhost:${port}`)
  })
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/target-app.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example target-app tests
git commit -m "feat: hostile legacy target app with injectable runtime conditions"
```

---

### Task 2: Capability schema

**Files:**
- Create: `src/capability/schema.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: zod schemas and inferred types — `CheckpointSchema`/`Checkpoint`, `TargetDescriptorSchema`/`TargetDescriptor`, `StepSchema`/`Step`, `BusinessOutcomeSchema`/`BusinessOutcome`, `CapabilitySchema`/`Capability`, `BindingSchema`/`Binding`, `ReplayResultSchema`/`ReplayResult`, and `capabilityRef(c): string` returning `"<key>@<version>"`.

- [ ] **Step 1: Write the failing test**

Create `tests/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CapabilitySchema, BindingSchema, capabilityRef } from '../src/capability/schema.js'

const valid = {
  apiVersion: 'capability/v1',
  key: 'quest-core/member.savings_balance',
  version: '1.0.0',
  title: 'Look up a member savings balance',
  description: 'Returns the share balance for a member number.',
  surface: { kind: 'web' },
  vendor: { product: 'quest-core', observedVersion: '8.3' },
  inputs: {
    type: 'object',
    required: ['memberId'],
    properties: { memberId: { type: 'string', pattern: '^[0-9]{5}$', 'x-sensitivity': 'pii' } },
  },
  outputs: {
    type: 'object',
    required: ['savingsBalance'],
    properties: { savingsBalance: { type: 'number' } },
  },
  steps: [
    {
      id: 's1',
      intent: 'Type the member number',
      action: 'fill',
      target: { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] },
      value: { fromInput: 'memberId' },
      checkpoint: { kind: 'field-has-value', role: 'textbox', name: 'Member No.' },
      onError: [],
      timeoutMs: 8000,
    },
  ],
  successCondition: { kind: 'text-present', framePath: ['main'], text: 'Share Balance' },
  businessOutcomes: [
    { code: 'MEMBER_NOT_FOUND', detect: { kind: 'text-present', text: 'No record found' }, terminal: true, message: 'No such member.' },
  ],
  risk: { class: 'read', irreversible: false, requiresApproval: false },
  provenance: { discoveredBy: 'test', discoveryRunId: 'run_1', recordedAt: '2026-09-17T00:00:00Z', humanEdits: [] },
  approval: { state: 'draft', replayStats: { attempts: 0, successes: 0, lastFailure: null } },
}

describe('CapabilitySchema', () => {
  it('accepts a well-formed capability', () => {
    expect(() => CapabilitySchema.parse(valid)).not.toThrow()
  })

  it('rejects a non-semver version', () => {
    expect(() => CapabilitySchema.parse({ ...valid, version: 'v1' })).toThrow()
  })

  it('rejects an unknown result of risk.class', () => {
    expect(() => CapabilitySchema.parse({ ...valid, risk: { ...valid.risk, class: 'destroy' } })).toThrow()
  })

  it('requires at least one step', () => {
    expect(() => CapabilitySchema.parse({ ...valid, steps: [] })).toThrow()
  })

  it('builds a ref from key and version', () => {
    expect(capabilityRef(CapabilitySchema.parse(valid))).toBe('quest-core/member.savings_balance@1.0.0')
  })
})

describe('BindingSchema', () => {
  it('rejects an inline credential value', () => {
    expect(() =>
      BindingSchema.parse({
        tenant: 't', capability: 'k@^1.0.0', entryPoint: 'http://localhost:4000/member/search',
        credentials: { ref: 'hunter2' }, overrides: {}, driftLog: [],
      }),
    ).toThrow()
  })

  it('accepts an env-prefixed credential ref', () => {
    expect(() =>
      BindingSchema.parse({
        tenant: 't', capability: 'k@^1.0.0', entryPoint: 'http://localhost:4000/member/search',
        credentials: { ref: 'env:FOO' }, overrides: {}, driftLog: [],
      }),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/schema.test.ts`
Expected: FAIL — cannot resolve `../src/capability/schema.js`.

- [ ] **Step 3: Write `src/capability/schema.ts`**

```ts
import { z } from 'zod'

const SEMVER = /^\d+\.\d+\.\d+$/

export const SensitivitySchema = z.enum(['pii', 'secret', 'safe'])

export const CheckpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text-present'), framePath: z.array(z.string()).optional(), text: z.string() }),
  z.object({ kind: z.literal('role-present'), framePath: z.array(z.string()).optional(), role: z.string(), nameContains: z.string().optional() }),
  z.object({ kind: z.literal('url-matches'), pattern: z.string() }),
  z.object({ kind: z.literal('field-has-value'), framePath: z.array(z.string()).optional(), role: z.string(), name: z.string() }),
])
export type Checkpoint = z.infer<typeof CheckpointSchema>

export const FallbackSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('name-attr'), value: z.string() }),
  z.object({ strategy: z.literal('nth-input-in-form'), form: z.number().int().min(0), index: z.number().int().min(0) }),
  z.object({ strategy: z.literal('nth-submit-in-form'), form: z.number().int().min(0), index: z.number().int().min(0) }),
  z.object({ strategy: z.literal('link-text'), value: z.string() }),
])

export const TargetDescriptorSchema = z.object({
  role: z.string(),
  name: z.string().optional(),
  labelText: z.string().optional(),
  framePath: z.array(z.string()).default([]),
  anchor: z
    .object({
      kind: z.literal('table-cell'),
      rowHeader: z.string(),
      offset: z.object({ col: z.number().int() }),
    })
    .optional(),
  fallbacks: z.array(FallbackSchema).default([]),
})
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>

export const ActionSchema = z.enum(['navigate', 'click', 'fill', 'select', 'read', 'waitFor', 'dismiss'])
export type ActionKind = z.infer<typeof ActionSchema>

export const RecoveryRungSchema = z.discriminatedUnion('when', [
  z.object({ when: z.literal('dialog-present'), match: z.string(), do: z.literal('dismiss') }),
  z.object({ when: z.literal('timeout'), do: z.literal('retry'), max: z.number().int().min(1).max(5), backoffMs: z.number().int().min(0) }),
  z.object({ when: z.literal('session-expired'), do: z.literal('reauth') }),
])
export type RecoveryRung = z.infer<typeof RecoveryRungSchema>

export const StepSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  action: ActionSchema,
  target: TargetDescriptorSchema.optional(),
  url: z.string().optional(),
  value: z.union([z.object({ fromInput: z.string() }), z.object({ literal: z.string() })]).optional(),
  extract: z.object({ into: z.string(), as: z.enum(['string', 'number', 'date']) }).optional(),
  checkpoint: CheckpointSchema,
  onError: z.array(RecoveryRungSchema).default([]),
  timeoutMs: z.number().int().min(100).max(60_000).default(8000),
})
export type Step = z.infer<typeof StepSchema>

export const BusinessOutcomeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  detect: CheckpointSchema,
  terminal: z.boolean(),
  message: z.string().optional(),
})
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>

export const JsonSchemaish = z.object({
  type: z.literal('object'),
  required: z.array(z.string()).default([]),
  properties: z.record(z.record(z.unknown())),
})

export const CapabilitySchema = z.object({
  apiVersion: z.literal('capability/v1'),
  key: z.string().min(1),
  version: z.string().regex(SEMVER),
  title: z.string().min(1),
  description: z.string().min(1),
  surface: z.object({ kind: z.enum(['web', 'desktop']) }),
  vendor: z.object({ product: z.string(), observedVersion: z.string().optional() }),
  inputs: JsonSchemaish,
  outputs: JsonSchemaish,
  steps: z.array(StepSchema).min(1),
  successCondition: CheckpointSchema,
  businessOutcomes: z.array(BusinessOutcomeSchema).default([]),
  risk: z.object({
    class: z.enum(['read', 'mutate']),
    irreversible: z.boolean(),
    requiresApproval: z.boolean(),
  }),
  provenance: z.object({
    discoveredBy: z.string(),
    discoveryRunId: z.string(),
    recordedAt: z.string(),
    humanEdits: z.array(z.object({ at: z.string(), by: z.string(), note: z.string() })).default([]),
  }),
  approval: z.object({
    state: z.enum(['draft', 'approved']),
    approvedBy: z.string().optional(),
    replayStats: z.object({
      attempts: z.number().int().min(0),
      successes: z.number().int().min(0),
      lastFailure: z.string().nullable(),
    }),
  }),
})
export type Capability = z.infer<typeof CapabilitySchema>

export const BindingSchema = z.object({
  tenant: z.string().min(1),
  capability: z.string().min(1),
  entryPoint: z.string().url(),
  credentials: z.object({ ref: z.string().regex(/^(env|vault):/, 'credentials must be a env: or vault: reference, never a literal') }).optional(),
  overrides: z.object({ steps: z.record(z.record(z.unknown())).optional() }).default({}),
  driftLog: z
    .array(z.object({ step: z.string(), resolvedVia: z.string(), count: z.number().int(), since: z.string() }))
    .default([]),
})
export type Binding = z.infer<typeof BindingSchema>

export const ReplayResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), outputs: z.record(z.unknown()), evidence: z.string() }),
  z.object({ status: z.literal('business_outcome'), code: z.string(), message: z.string(), evidence: z.string() }),
  z.object({ status: z.literal('blocked'), interventionId: z.string(), reason: z.string(), evidence: z.string() }),
  z.object({
    status: z.literal('failed'),
    step: z.string(), expected: z.string(), observed: z.string(),
    class: z.enum(['resolver_not_found', 'resolver_ambiguous', 'checkpoint_failed', 'policy_denied', 'surface_error', 'input_invalid']),
    evidence: z.string(),
  }),
])
export type ReplayResult = z.infer<typeof ReplayResultSchema>

export function capabilityRef(c: Pick<Capability, 'key' | 'version'>): string {
  return `${c.key}@${c.version}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/schema.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capability/schema.ts tests/schema.test.ts
git commit -m "feat: typed capability and binding schemas with a four-way result contract"
```

---

### Task 3: Store — persistence and resolution

**Files:**
- Create: `src/capability/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Capability`, `Binding`, `CapabilitySchema`, `BindingSchema` from Task 2.
- Produces: `class FileStore` with `saveCapability(c): Promise<void>`, `loadCapability(ref): Promise<Capability>`, `listCapabilities(): Promise<Capability[]>`, `saveBinding(b): Promise<void>`, `loadBinding(tenant, key): Promise<Binding | null>`, `resolveForTenant(ref, tenant): Promise<{capability: Capability; binding: Binding | null}>`, `recordDrift(tenant, key, step, resolvedVia): Promise<void>`, `recordReplayAttempt(ref, ok, failure): Promise<void>`. `ref` is `"<key>@<version>"`.

- [ ] **Step 1: Write the failing test**

Create `tests/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/capability/store.js'
import type { Capability } from '../src/capability/schema.js'

const cap = (over: Partial<Capability> = {}): Capability => ({
  apiVersion: 'capability/v1',
  key: 'quest-core/member.savings_balance',
  version: '1.0.0',
  title: 'Look up balance',
  description: 'desc',
  surface: { kind: 'web' },
  vendor: { product: 'quest-core' },
  inputs: { type: 'object', required: ['memberId'], properties: { memberId: { type: 'string' } } },
  outputs: { type: 'object', required: [], properties: { savingsBalance: { type: 'number' } } },
  steps: [{ id: 's1', intent: 'i', action: 'click', target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] }, checkpoint: { kind: 'text-present', text: 'Share Balance' }, onError: [], timeoutMs: 8000 }],
  successCondition: { kind: 'text-present', text: 'Share Balance' },
  businessOutcomes: [],
  risk: { class: 'read', irreversible: false, requiresApproval: false },
  provenance: { discoveredBy: 't', discoveryRunId: 'r', recordedAt: '2026-09-17T00:00:00Z', humanEdits: [] },
  approval: { state: 'draft', replayStats: { attempts: 0, successes: 0, lastFailure: null } },
  ...over,
})

let dir: string
let store: FileStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cap-store-'))
  store = new FileStore(dir)
})

describe('FileStore', () => {
  it('round-trips a capability', async () => {
    await store.saveCapability(cap())
    const got = await store.loadCapability('quest-core/member.savings_balance@1.0.0')
    expect(got.title).toBe('Look up balance')
  })

  it('throws a clear error for a missing capability', async () => {
    await expect(store.loadCapability('nope@1.0.0')).rejects.toThrow(/capability not found: nope@1.0.0/)
  })

  it('applies a binding step override on resolveForTenant', async () => {
    await store.saveCapability(cap())
    await store.saveBinding({
      tenant: 'firstvalley-cu',
      capability: 'quest-core/member.savings_balance@1.0.0',
      entryPoint: 'http://localhost:4000/member/search',
      overrides: { steps: { s1: { target: { role: 'button', name: 'Inquire Now', framePath: [], fallbacks: [] } } } },
      driftLog: [],
    })
    const { capability } = await store.resolveForTenant('quest-core/member.savings_balance@1.0.0', 'firstvalley-cu')
    expect(capability.steps[0]!.target!.name).toBe('Inquire Now')
  })

  it('leaves the capability untouched when the tenant has no binding', async () => {
    await store.saveCapability(cap())
    const { capability, binding } = await store.resolveForTenant('quest-core/member.savings_balance@1.0.0', 'other-cu')
    expect(binding).toBeNull()
    expect(capability.steps[0]!.target!.name).toBe('Inquire')
  })

  it('accumulates a drift count per step and rung', async () => {
    await store.saveCapability(cap())
    await store.saveBinding({
      tenant: 'firstvalley-cu', capability: 'quest-core/member.savings_balance@1.0.0',
      entryPoint: 'http://localhost:4000/member/search', overrides: {}, driftLog: [],
    })
    await store.recordDrift('firstvalley-cu', 'quest-core/member.savings_balance', 's1', 'fallback[0]')
    await store.recordDrift('firstvalley-cu', 'quest-core/member.savings_balance', 's1', 'fallback[0]')
    const b = await store.loadBinding('firstvalley-cu', 'quest-core/member.savings_balance')
    expect(b!.driftLog[0]).toMatchObject({ step: 's1', resolvedVia: 'fallback[0]', count: 2 })
  })

  it('accumulates replay stats', async () => {
    await store.saveCapability(cap())
    const ref = 'quest-core/member.savings_balance@1.0.0'
    await store.recordReplayAttempt(ref, true, null)
    await store.recordReplayAttempt(ref, false, 'checkpoint_failed at s1')
    const got = await store.loadCapability(ref)
    expect(got.approval.replayStats).toMatchObject({ attempts: 2, successes: 1, lastFailure: 'checkpoint_failed at s1' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/capability/store.js`.

- [ ] **Step 3: Write `src/capability/store.ts`**

```ts
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CapabilitySchema, BindingSchema, type Capability, type Binding } from './schema.js'

function splitRef(ref: string): { key: string; version: string } {
  const at = ref.lastIndexOf('@')
  if (at < 0) throw new Error(`malformed capability ref: ${ref}`)
  return { key: ref.slice(0, at), version: ref.slice(at + 1) }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Deep-merges override fragments over a base object. Arrays are replaced wholesale:
 *  a tenant that overrides a fallback ladder means to replace it, not to append to it. */
function mergeDeep<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base
  if (Array.isArray(over) || typeof over !== 'object') return over as T
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export class FileStore {
  constructor(private readonly root: string) {}

  private capPath(key: string, version: string): string {
    return join(this.root, 'capabilities', key, `${version}.json`)
  }
  private bindPath(tenant: string, key: string): string {
    return join(this.root, 'bindings', tenant, `${key.replace(/\//g, '__')}.json`)
  }

  async saveCapability(c: Capability): Promise<void> {
    const parsed = CapabilitySchema.parse(c)
    await writeJson(this.capPath(parsed.key, parsed.version), parsed)
  }

  async loadCapability(ref: string): Promise<Capability> {
    const { key, version } = splitRef(ref)
    const raw = await readJson<unknown>(this.capPath(key, version))
    if (!raw) throw new Error(`capability not found: ${ref}`)
    return CapabilitySchema.parse(raw)
  }

  async listCapabilities(): Promise<Capability[]> {
    const root = join(this.root, 'capabilities')
    const out: Capability[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith('.json')) {
          const raw = await readJson<unknown>(p)
          if (raw) out.push(CapabilitySchema.parse(raw))
        }
      }
    }
    await walk(root)
    return out
  }

  async saveBinding(b: Binding): Promise<void> {
    const parsed = BindingSchema.parse(b)
    const { key } = splitRef(parsed.capability.replace('@^', '@'))
    await writeJson(this.bindPath(parsed.tenant, key), parsed)
  }

  async loadBinding(tenant: string, key: string): Promise<Binding | null> {
    const raw = await readJson<unknown>(this.bindPath(tenant, key))
    return raw ? BindingSchema.parse(raw) : null
  }

  /** Binding override -> vendor capability. The ladder mirrors the version ladder
   *  the runtime kernel already uses for skills. */
  async resolveForTenant(ref: string, tenant: string): Promise<{ capability: Capability; binding: Binding | null }> {
    const capability = await this.loadCapability(ref)
    const binding = await this.loadBinding(tenant, capability.key)
    if (!binding?.overrides?.steps) return { capability, binding }

    const steps = capability.steps.map((s) => {
      const over = binding.overrides.steps?.[s.id]
      return over ? mergeDeep(s, over) : s
    })
    return { capability: { ...capability, steps }, binding }
  }

  async recordDrift(tenant: string, key: string, step: string, resolvedVia: string): Promise<void> {
    const b = await this.loadBinding(tenant, key)
    if (!b) return
    const existing = b.driftLog.find((d) => d.step === step && d.resolvedVia === resolvedVia)
    if (existing) existing.count += 1
    else b.driftLog.push({ step, resolvedVia, count: 1, since: new Date().toISOString() })
    await this.saveBinding(b)
  }

  async recordReplayAttempt(ref: string, ok: boolean, failure: string | null): Promise<void> {
    const c = await this.loadCapability(ref)
    c.approval.replayStats.attempts += 1
    if (ok) c.approval.replayStats.successes += 1
    else c.approval.replayStats.lastFailure = failure
    await this.saveCapability(c)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capability/store.ts tests/store.test.ts
git commit -m "feat: file store with tenant binding resolution, drift counts and replay stats"
```

---

### Task 4: Policy — allowlist, risk classification, and the PASS/HOLD/DENY gate

**Files:**
- Create: `src/policy/allowlist.ts`, `src/policy/gate.ts`, `src/policy/redact.ts`
- Create: `policy.json`
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `ActionKind` from Task 2.
- Produces:
  - `loadPolicy(path?): Promise<PolicyConfig>` where `PolicyConfig = { allowedOrigins: string[]; allowedPathPrefixes: string[]; allowedActions: ActionKind[] }`.
  - `classifyAction(a: ActionKind): 'read' | 'mutate'`.
  - `isUrlAllowed(url, cfg): boolean`.
  - `gate(req: GateRequest): GateVerdict` where `GateRequest = { action: ActionKind; url: string; policy: PolicyConfig; approvalState: 'draft'|'approved'; leaseHeld: boolean }` and `GateVerdict = { verdict: 'PASS' } | { verdict: 'HOLD'; reason: string } | { verdict: 'DENY'; reason: string }`.
  - `redactValue(v, sensitivity)`, `redactParams(params, inputSchema)`.

- [ ] **Step 1: Write the failing test**

Create `tests/policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { classifyAction, isUrlAllowed, type PolicyConfig } from '../src/policy/allowlist.js'
import { gate } from '../src/policy/gate.js'
import { redactParams } from '../src/policy/redact.js'

const policy: PolicyConfig = {
  allowedOrigins: ['http://localhost:4000'],
  allowedPathPrefixes: ['/member', '/nav', '/'],
  allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
}

describe('classifyAction', () => {
  it('treats reading and navigating as read', () => {
    expect(classifyAction('read')).toBe('read')
    expect(classifyAction('navigate')).toBe('read')
    expect(classifyAction('waitFor')).toBe('read')
  })
  it('treats clicking and filling as mutate', () => {
    expect(classifyAction('click')).toBe('mutate')
    expect(classifyAction('fill')).toBe('mutate')
  })
})

describe('isUrlAllowed', () => {
  it('allows a listed origin and prefix', () => {
    expect(isUrlAllowed('http://localhost:4000/member/search', policy)).toBe(true)
  })
  it('rejects an unlisted origin', () => {
    expect(isUrlAllowed('http://evil.test/member/search', policy)).toBe(false)
  })
  it('rejects an unlisted path prefix', () => {
    expect(isUrlAllowed('http://localhost:4000/admin/wipe', { ...policy, allowedPathPrefixes: ['/member'] })).toBe(false)
  })
})

describe('gate', () => {
  const base = { url: 'http://localhost:4000/member/search', policy, approvalState: 'approved' as const, leaseHeld: true }

  it('passes an allowed read', () => {
    expect(gate({ ...base, action: 'read' })).toEqual({ verdict: 'PASS' })
  })

  it('denies an action outside the allowlist', () => {
    expect(gate({ ...base, action: 'select' })).toMatchObject({ verdict: 'DENY', reason: expect.stringContaining('action_not_permitted') })
  })

  it('denies a url outside the allowlist', () => {
    expect(gate({ ...base, action: 'read', url: 'http://evil.test/x' })).toMatchObject({ verdict: 'DENY' })
  })

  it('holds a mutating action on a draft capability', () => {
    expect(gate({ ...base, action: 'click', approvalState: 'draft' })).toMatchObject({ verdict: 'HOLD', reason: expect.stringContaining('unapproved_mutation') })
  })

  it('passes a mutating action on an approved capability', () => {
    expect(gate({ ...base, action: 'click', approvalState: 'approved' })).toEqual({ verdict: 'PASS' })
  })

  it('denies any action when the lease is not held', () => {
    expect(gate({ ...base, action: 'read', leaseHeld: false })).toMatchObject({ verdict: 'DENY', reason: expect.stringContaining('lease_not_held') })
  })

  it('reads a draft capability without holding', () => {
    expect(gate({ ...base, action: 'read', approvalState: 'draft' })).toEqual({ verdict: 'PASS' })
  })
})

describe('redactParams', () => {
  const schema = {
    type: 'object' as const,
    required: ['memberId'],
    properties: {
      memberId: { type: 'string', 'x-sensitivity': 'pii' },
      branch: { type: 'string', 'x-sensitivity': 'safe' },
    },
  }

  it('hashes a pii field and leaves a safe field alone', () => {
    const out = redactParams({ memberId: '40021', branch: 'BKK' }, schema)
    expect(out.branch).toBe('BKK')
    expect(out.memberId).toMatch(/^sha256:[0-9a-f]{12}$/)
    expect(String(out.memberId)).not.toContain('40021')
  })

  it('redacts an unknown field conservatively', () => {
    const out = redactParams({ surprise: 'secret-value' }, schema)
    expect(out.surprise).toBe('[redacted]')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL — cannot resolve `../src/policy/allowlist.js`.

- [ ] **Step 3: Write `policy.json`**

```json
{
  "allowedOrigins": ["http://localhost:4000"],
  "allowedPathPrefixes": ["/", "/nav", "/member"],
  "allowedActions": ["navigate", "click", "fill", "read", "waitFor", "dismiss"]
}
```

- [ ] **Step 4: Write `src/policy/allowlist.ts`**

```ts
import { readFile } from 'node:fs/promises'
import type { ActionKind } from '../capability/schema.js'

export interface PolicyConfig {
  allowedOrigins: string[]
  allowedPathPrefixes: string[]
  allowedActions: ActionKind[]
}

/** Risk is derived from the action verb rather than hand-labelled per step, so a
 *  newly recorded step cannot arrive unclassified. Anything that can change server
 *  state is `mutate`; observation is `read`. */
const READ_ACTIONS = new Set<ActionKind>(['navigate', 'read', 'waitFor'])

export function classifyAction(a: ActionKind): 'read' | 'mutate' {
  return READ_ACTIONS.has(a) ? 'read' : 'mutate'
}

export function isUrlAllowed(url: string, cfg: PolicyConfig): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!cfg.allowedOrigins.includes(u.origin)) return false
  return cfg.allowedPathPrefixes.some((p) => u.pathname === p || u.pathname.startsWith(p === '/' ? '/' : p + '/') || u.pathname.startsWith(p))
}

export async function loadPolicy(path = 'policy.json'): Promise<PolicyConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as PolicyConfig
}
```

- [ ] **Step 5: Write `src/policy/gate.ts`**

```ts
import type { ActionKind } from '../capability/schema.js'
import { classifyAction, isUrlAllowed, type PolicyConfig } from './allowlist.js'

export interface GateRequest {
  action: ActionKind
  url: string
  policy: PolicyConfig
  approvalState: 'draft' | 'approved'
  leaseHeld: boolean
}

export type GateVerdict =
  | { verdict: 'PASS' }
  | { verdict: 'HOLD'; reason: string }
  | { verdict: 'DENY'; reason: string }

/** Three states, deterministic inputs.
 *
 *  HOLD is not a failure — it is a decision a human owes us, so it routes to the
 *  intervention queue rather than to an error. DENY is a refusal: nothing a human
 *  can say at this moment makes it permissible, because it is outside the
 *  configured allowlist.
 *
 *  Note what is NOT an input: model confidence. A safety gate keyed on a
 *  self-reported score is a probabilistic guardrail, which is a contradiction. */
export function gate(req: GateRequest): GateVerdict {
  if (!req.leaseHeld) return { verdict: 'DENY', reason: 'lease_not_held' }

  if (!req.policy.allowedActions.includes(req.action)) {
    return { verdict: 'DENY', reason: `action_not_permitted:${req.action}` }
  }

  if (!isUrlAllowed(req.url, req.policy)) {
    return { verdict: 'DENY', reason: `url_not_permitted:${req.url}` }
  }

  if (classifyAction(req.action) === 'mutate' && req.approvalState === 'draft') {
    return { verdict: 'HOLD', reason: `unapproved_mutation:${req.action}` }
  }

  return { verdict: 'PASS' }
}
```

- [ ] **Step 6: Write `src/policy/redact.ts`**

```ts
import { createHash } from 'node:crypto'

const SALT = process.env.REDACTION_SALT ?? 'capability-engine-dev-salt'

export type Sensitivity = 'pii' | 'secret' | 'safe'

export function redactValue(v: unknown, s: Sensitivity): unknown {
  if (s === 'safe') return v
  if (s === 'secret') return '[redacted]'
  const h = createHash('sha256').update(SALT).update(String(v)).digest('hex').slice(0, 12)
  return `sha256:${h}`
}

interface InputSchemaish {
  properties: Record<string, Record<string, unknown>>
}

/** Sensitivity is read from the schema, not guessed from the value. A field the
 *  schema does not mention is redacted rather than passed through: an unknown
 *  field is exactly the case where we cannot reason about what it holds. */
export function redactParams(
  params: Record<string, unknown>,
  schema: InputSchemaish,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    const prop = schema.properties[k]
    if (!prop) {
      out[k] = '[redacted]'
      continue
    }
    const s = (prop['x-sensitivity'] as Sensitivity | undefined) ?? 'safe'
    out[k] = redactValue(v, s)
  }
  return out
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/policy.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 8: Commit**

```bash
git add policy.json src/policy tests/policy.test.ts
git commit -m "feat: three-state policy gate on deterministic inputs, verb-derived risk, schema-driven redaction"
```

---

### Task 5: Surface — observation, resolver ladder, and the gated Playwright adapter

**Files:**
- Create: `src/surface/types.ts`, `src/surface/resolver.ts`, `src/surface/web.ts`
- Test: `tests/resolver.test.ts`, `tests/surface.test.ts`

**Interfaces:**
- Consumes: `TargetDescriptor`, `ActionKind`, `Checkpoint` (Task 2); `gate`, `PolicyConfig` (Task 4).
- Produces:
  - `interface Observation { url: string; frames: FrameSnapshot[]; title: string }`, `interface FrameSnapshot { path: string[]; nodes: A11yNode[]; text: string }`, `interface A11yNode { role: string; name: string; nameAttr?: string; labelText?: string; framePath: string[]; ref: string }`.
  - `type Resolution = { kind: 'one'; node: A11yNode; via: string } | { kind: 'none' } | { kind: 'ambiguous'; count: number }`.
  - `resolveDescriptor(nodes: A11yNode[], t: TargetDescriptor): Resolution` — pure, testable without a browser.
  - `class WebSurface` with `open(url)`, `observe()`, `resolve(t)`, `act(action, node, value?)`, `readText(t)`, `screenshot(path)`, `domSnapshot(path)`, `close()`, and `setContext({ approvalState, leaseHeld })`.
  - `class PolicyError extends Error` carrying `verdict: 'HOLD' | 'DENY'` and `reason: string`.

- [ ] **Step 1: Write the failing resolver test**

Create `tests/resolver.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveDescriptor, type A11yNode } from '../src/surface/resolver.js'

const node = (over: Partial<A11yNode>): A11yNode => ({
  role: 'textbox', name: '', framePath: ['main'], ref: 'r1', ...over,
})

describe('resolveDescriptor', () => {
  it('matches exactly one node by role and accessible name', () => {
    const nodes = [node({ name: 'Member No.', ref: 'a' }), node({ role: 'button', name: 'Inquire', ref: 'b' })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toMatchObject({ kind: 'one', via: 'primary' })
    expect(r.kind === 'one' && r.node.ref).toBe('a')
  })

  it('returns none when nothing matches', () => {
    const r = resolveDescriptor([node({ name: 'Other' })], { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toEqual({ kind: 'none' })
  })

  it('returns ambiguous when two nodes match, rather than picking the first', () => {
    const nodes = [node({ name: 'Member No.', ref: 'a' }), node({ name: 'Member No.', ref: 'b' })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('does not match across frames', () => {
    const nodes = [node({ name: 'Member No.', framePath: ['nav'] })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toEqual({ kind: 'none' })
  })

  it('falls back to labelText when the accessible name is empty', () => {
    const nodes = [node({ name: '', labelText: 'Member No.', ref: 'a' })]
    const r = resolveDescriptor(nodes, { role: 'textbox', name: 'Member No.', framePath: ['main'], fallbacks: [] })
    expect(r).toMatchObject({ kind: 'one', via: 'labelText' })
  })

  it('falls back to the name attribute and reports the rung it used', () => {
    const nodes = [node({ name: '', nameAttr: 'ctl00$mbrNo', ref: 'a' })]
    const r = resolveDescriptor(nodes, {
      role: 'textbox', name: 'Member No.', framePath: ['main'],
      fallbacks: [{ strategy: 'name-attr', value: 'ctl00$mbrNo' }],
    })
    expect(r).toMatchObject({ kind: 'one', via: 'fallback[0]:name-attr' })
  })

  it('prefers the primary descriptor over an available fallback', () => {
    const nodes = [node({ name: 'Member No.', nameAttr: 'ctl00$mbrNo', ref: 'a' })]
    const r = resolveDescriptor(nodes, {
      role: 'textbox', name: 'Member No.', framePath: ['main'],
      fallbacks: [{ strategy: 'name-attr', value: 'ctl00$mbrNo' }],
    })
    expect(r).toMatchObject({ via: 'primary' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/resolver.test.ts`
Expected: FAIL — cannot resolve `../src/surface/resolver.js`.

- [ ] **Step 3: Write `src/surface/types.ts`**

```ts
export interface A11yNode {
  role: string
  name: string
  nameAttr?: string
  labelText?: string
  framePath: string[]
  ref: string
}

export interface FrameSnapshot {
  path: string[]
  nodes: A11yNode[]
  text: string
}

export interface Observation {
  url: string
  title: string
  frames: FrameSnapshot[]
}

export type Resolution =
  | { kind: 'one'; node: A11yNode; via: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

export class PolicyError extends Error {
  constructor(
    readonly verdict: 'HOLD' | 'DENY',
    readonly reason: string,
  ) {
    super(`policy ${verdict}: ${reason}`)
    this.name = 'PolicyError'
  }
}
```

- [ ] **Step 4: Write `src/surface/resolver.ts`**

```ts
import type { TargetDescriptor } from '../capability/schema.js'
import type { A11yNode, Resolution } from './types.js'

export type { A11yNode, Resolution } from './types.js'

const samePath = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function uniqueOrReport(matches: A11yNode[], via: string): Resolution | null {
  if (matches.length === 1) return { kind: 'one', node: matches[0]!, via }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
  return null
}

/** Resolve a descriptor to exactly one node, trying rungs in order and reporting
 *  which one fired. The `via` value is what makes drift measurable: a tenant that
 *  keeps resolving through `fallback[1]` is drifting away from the base recording.
 *
 *  Two or more matches is never an action. Picking the first of two candidate
 *  controls is how automation quietly operates on the wrong record. */
export function resolveDescriptor(nodes: A11yNode[], t: TargetDescriptor): Resolution {
  const inFrame = nodes.filter((n) => samePath(n.framePath, t.framePath))

  if (t.name) {
    const byName = inFrame.filter((n) => n.role === t.role && n.name === t.name)
    const r = uniqueOrReport(byName, 'primary')
    if (r) return r

    const byLabel = inFrame.filter((n) => n.role === t.role && n.labelText === t.name)
    const rl = uniqueOrReport(byLabel, 'labelText')
    if (rl) return rl
  }

  if (t.labelText) {
    const byLabel = inFrame.filter((n) => n.role === t.role && n.labelText === t.labelText)
    const r = uniqueOrReport(byLabel, 'labelText')
    if (r) return r
  }

  for (const [i, fb] of t.fallbacks.entries()) {
    let matches: A11yNode[] = []
    if (fb.strategy === 'name-attr') matches = inFrame.filter((n) => n.nameAttr === fb.value)
    else if (fb.strategy === 'link-text') matches = inFrame.filter((n) => n.role === 'link' && n.name === fb.value)
    else matches = inFrame.filter((n) => n.role === (fb.strategy === 'nth-submit-in-form' ? 'button' : 'textbox'))
        .slice(fb.index, fb.index + 1)

    const r = uniqueOrReport(matches, `fallback[${i}]:${fb.strategy}`)
    if (r) return r
  }

  return { kind: 'none' }
}
```

- [ ] **Step 5: Run the resolver test to verify it passes**

Run: `npx vitest run tests/resolver.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write `src/surface/web.ts`**

This is the only file in the repo permitted to import `playwright`.

```ts
import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright'
import { writeFile } from 'node:fs/promises'
import type { ActionKind, TargetDescriptor, Checkpoint } from '../capability/schema.js'
import { gate } from '../policy/gate.js'
import type { PolicyConfig } from '../policy/allowlist.js'
import { resolveDescriptor } from './resolver.js'
import { PolicyError, type A11yNode, type FrameSnapshot, type Observation, type Resolution } from './types.js'

export type { Observation, A11yNode, Resolution } from './types.js'
export { PolicyError } from './types.js'

const EXTRACT = `() => {
  const out = []
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'submit' || t === 'button') return 'button'
      if (t === 'checkbox') return 'checkbox'
      return 'textbox'
    }
    if (tag === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'select') return 'combobox'
    if (tag === 'table') return 'table'
    return null
  }
  const labelFor = (el) => {
    const cell = el.closest('td')
    const prev = cell && cell.previousElementSibling
    if (prev) return prev.textContent.trim()
    return ''
  }
  let i = 0
  for (const el of document.querySelectorAll('input,button,a,select,table')) {
    const role = roleOf(el)
    if (!role) continue
    const nameAttr = el.getAttribute('name') || undefined
    const value = el.getAttribute('value') || ''
    const label = labelFor(el)
    const name =
      role === 'button' ? (value || el.textContent.trim())
      : role === 'link' ? el.textContent.trim()
      : role === 'table' ? (el.textContent.trim().slice(0, 40))
      : label
    el.setAttribute('data-cap-ref', 'n' + i)
    out.push({ role, name, nameAttr, labelText: label, ref: 'n' + (i++) })
  }
  return out
}`

export class WebSurface {
  private browser!: Browser
  private context!: BrowserContext
  private page!: Page
  private approvalState: 'draft' | 'approved' = 'draft'
  private leaseHeld = true

  constructor(private readonly policy: PolicyConfig, private readonly headless = false) {}

  setContext(c: { approvalState?: 'draft' | 'approved'; leaseHeld?: boolean }): void {
    if (c.approvalState) this.approvalState = c.approvalState
    if (c.leaseHeld !== undefined) this.leaseHeld = c.leaseHeld
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless })
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
  }

  /** Every action funnels through here. The gate lives inside the only module that
   *  can touch the surface, so neither discovery nor replay can route around it. */
  private check(action: ActionKind, url: string): void {
    const v = gate({ action, url, policy: this.policy, approvalState: this.approvalState, leaseHeld: this.leaseHeld })
    if (v.verdict !== 'PASS') throw new PolicyError(v.verdict, v.reason)
  }

  private frames(): { path: string[]; frame: Frame }[] {
    const out: { path: string[]; frame: Frame }[] = []
    for (const f of this.page.frames()) {
      const nm = f.name()
      out.push({ path: nm ? [nm] : [], frame: f })
    }
    return out
  }

  async open(url: string): Promise<void> {
    this.check('navigate', url)
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async observe(): Promise<Observation> {
    const frames: FrameSnapshot[] = []
    for (const { path, frame } of this.frames()) {
      let nodes: Omit<A11yNode, 'framePath'>[] = []
      let text = ''
      try {
        nodes = (await frame.evaluate(EXTRACT)) as Omit<A11yNode, 'framePath'>[]
        text = (await frame.evaluate('() => document.body ? document.body.innerText : ""')) as string
      } catch {
        continue
      }
      frames.push({ path, text, nodes: nodes.map((n) => ({ ...n, framePath: path })) })
    }
    return { url: this.page.url(), title: await this.page.title(), frames }
  }

  async resolve(t: TargetDescriptor): Promise<Resolution> {
    const obs = await this.observe()
    return resolveDescriptor(obs.frames.flatMap((f) => f.nodes), t)
  }

  private frameFor(path: string[]): Frame {
    const hit = this.frames().find((f) => f.path.join('/') === path.join('/'))
    return hit?.frame ?? this.page.mainFrame()
  }

  async act(action: ActionKind, node: A11yNode, value?: string): Promise<void> {
    this.check(action, this.page.url())
    const frame = this.frameFor(node.framePath)
    const loc = frame.locator(`[data-cap-ref="${node.ref}"]`)
    if (action === 'click') await loc.click()
    else if (action === 'fill') await loc.fill(value ?? '')
    else if (action === 'select') await loc.selectOption(value ?? '')
    else if (action === 'dismiss') await loc.click()
    else throw new Error(`act() cannot perform ${action}`)
  }

  async checkpointHolds(c: Checkpoint): Promise<{ ok: boolean; observed: string }> {
    const obs = await this.observe()
    const scope = (path?: string[]) =>
      path ? obs.frames.filter((f) => f.path.join('/') === path.join('/')) : obs.frames

    if (c.kind === 'text-present') {
      const frames = scope(c.framePath)
      const ok = frames.some((f) => f.text.includes(c.text))
      return { ok, observed: ok ? `found "${c.text}"` : `text not present; page text begins "${(frames[0]?.text ?? '').slice(0, 120)}"` }
    }
    if (c.kind === 'url-matches') {
      const ok = new RegExp(c.pattern).test(obs.url)
      return { ok, observed: obs.url }
    }
    const nodes = scope(c.framePath).flatMap((f) => f.nodes)
    if (c.kind === 'role-present') {
      const ok = nodes.some((n) => n.role === c.role && (!c.nameContains || n.name.includes(c.nameContains)))
      return { ok, observed: ok ? `role ${c.role} present` : `roles present: ${[...new Set(nodes.map((n) => n.role))].join(',')}` }
    }
    const ok = nodes.some((n) => n.role === c.role && (n.name === c.name || n.labelText === c.name))
    return { ok, observed: ok ? `field ${c.name} present` : `field ${c.name} not found` }
  }

  async readText(t: TargetDescriptor): Promise<string> {
    this.check('read', this.page.url())
    const obs = await this.observe()
    const frames = obs.frames.filter((f) => f.path.join('/') === t.framePath.join('/'))
    return frames.map((f) => f.text).join('\n')
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true })
  }

  async domSnapshot(path: string): Promise<void> {
    await writeFile(path, await this.page.content(), 'utf8')
  }

  url(): string {
    return this.page.url()
  }

  async close(): Promise<void> {
    await this.browser?.close()
  }
}
```

- [ ] **Step 7: Write the surface integration test**

Create `tests/surface.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../target-app/server.js'
import { WebSurface, PolicyError } from '../src/surface/web.js'
import type { PolicyConfig } from '../src/policy/allowlist.js'

const PORT = 4112
const base = `http://localhost:${PORT}`
const policy: PolicyConfig = {
  allowedOrigins: [base],
  allowedPathPrefixes: ['/', '/nav', '/member'],
  allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
}

let server: Server
let surface: WebSurface

beforeAll(async () => {
  server = createServer().listen(PORT)
  await new Promise((r) => server.once('listening', r))
  surface = new WebSurface(policy, true)
  await surface.start()
  surface.setContext({ approvalState: 'approved', leaseHeld: true })
})

afterAll(async () => {
  await surface.close()
  await new Promise((r) => server.close(() => r(undefined)))
})

describe('WebSurface against the hostile app', () => {
  it('finds the member number box by its adjacent label, with no id present', async () => {
    await surface.open(base + '/member/search')
    const r = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    expect(r.kind).toBe('one')
  })

  it('fills and clicks through to a balance', async () => {
    await surface.open(base + '/member/search')
    const box = await surface.resolve({ role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] })
    if (box.kind !== 'one') throw new Error('box not resolved')
    await surface.act('fill', box.node, '40021')
    const btn = await surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })
    if (btn.kind !== 'one') throw new Error('button not resolved')
    await surface.act('click', btn.node)
    const cp = await surface.checkpointHolds({ kind: 'text-present', text: 'Share Balance' })
    expect(cp.ok).toBe(true)
  })

  it('refuses to navigate outside the allowlist', async () => {
    await expect(surface.open('http://evil.test/')).rejects.toBeInstanceOf(PolicyError)
  })

  it('refuses to act at all when the lease is not held', async () => {
    await surface.open(base + '/member/search')
    surface.setContext({ leaseHeld: false })
    const r = await surface.resolve({ role: 'button', name: 'Inquire', framePath: [], fallbacks: [] })
    if (r.kind !== 'one') throw new Error('not resolved')
    await expect(surface.act('click', r.node)).rejects.toBeInstanceOf(PolicyError)
    surface.setContext({ leaseHeld: true })
  })
})
```

- [ ] **Step 8: Run the surface test to verify it passes**

Run: `npx vitest run tests/surface.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
git add src/surface tests/resolver.test.ts tests/surface.test.ts
git commit -m "feat: accessibility-based surface with exactly-one resolver ladder and an inline policy gate"
```

---

### Task 6: Discovery — the real LLM loop

**Files:**
- Create: `src/discover/model.ts`, `src/discover/prompt.ts`, `src/discover/loop.ts`, `src/evidence/recorder.ts`
- Create: `src/cli/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `WebSurface`, `Observation` (Task 5); `loadPolicy` (Task 4).
- Produces:
  - `interface ModelClient { propose(input: ProposeInput): Promise<ProposedAction> }`.
  - `interface ProposeInput { goal: string; observation: Observation; history: string[] }`.
  - `type ProposedAction = { kind: 'act'; action: ActionKind; target: TargetDescriptor; value?: string; intent: string } | { kind: 'extract'; name: string; as: 'string'|'number'|'date'; from: TargetDescriptor; intent: string } | { kind: 'done'; summary: string } | { kind: 'stuck'; why: string }`.
  - `class OpenRouterModel implements ModelClient`.
  - `class ThrowingModel implements ModelClient` — used by replay tests to prove absence.
  - `interface Trace { goal: string; runId: string; entryPoint: string; model: string; steps: TraceStep[]; extracted: Record<string, {value: string; as: string; from: TargetDescriptor}>; observedOutcomes: {text: string; url: string}[] }`.
  - `runDiscovery(opts): Promise<Trace>`.
  - `class Recorder` with `event(type, data)`, `shot(surface, label)`, `dom(surface, label)`, `dir`.

- [ ] **Step 1: Write the failing test**

Create `tests/discover.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../target-app/server.js'
import { runDiscovery } from '../src/discover/loop.js'
import type { ModelClient, ProposedAction } from '../src/discover/model.js'

const PORT = 4113
const base = `http://localhost:${PORT}`
let server: Server

beforeAll(async () => {
  server = createServer().listen(PORT)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

/** A scripted stand-in for the model, so the loop itself is testable without
 *  spending tokens. The real model run is the CLI demo, recorded in /evidence. */
class ScriptedModel implements ModelClient {
  private i = 0
  constructor(private readonly script: ProposedAction[]) {}
  async propose(): Promise<ProposedAction> {
    const next = this.script[this.i++]
    if (!next) throw new Error('script exhausted')
    return next
  }
}

describe('runDiscovery', () => {
  it('drives the surface to the goal and emits a trace', async () => {
    const store = await mkdtemp(join(tmpdir(), 'disc-'))
    const model = new ScriptedModel([
      { kind: 'act', action: 'fill', intent: 'Type the member number', value: '40021',
        target: { role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] } },
      { kind: 'act', action: 'click', intent: 'Submit the inquiry',
        target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] } },
      { kind: 'extract', name: 'savingsBalance', as: 'number', intent: 'Read the share balance',
        from: { role: 'table', name: '', framePath: [], fallbacks: [] } },
      { kind: 'done', summary: 'read the balance' },
    ])

    const trace = await runDiscovery({
      goal: 'look up member 40021 and read their savings balance',
      entryPoint: base + '/member/search',
      model, storeRoot: store, headless: true, maxSteps: 10,
      policyOverride: {
        allowedOrigins: [base],
        allowedPathPrefixes: ['/', '/nav', '/member'],
        allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
      },
    })

    expect(trace.steps).toHaveLength(2)
    expect(trace.steps[0]!.action).toBe('fill')
    expect(trace.extracted.savingsBalance!.value).toContain('1284.55')
    expect(trace.observedOutcomes.length).toBeGreaterThan(0)
  })

  it('stops with a stuck trace when the model gives up', async () => {
    const store = await mkdtemp(join(tmpdir(), 'disc-'))
    const model = new ScriptedModel([{ kind: 'stuck', why: 'cannot find the control' }])
    await expect(
      runDiscovery({
        goal: 'g', entryPoint: base + '/member/search', model, storeRoot: store,
        headless: true, maxSteps: 5,
        policyOverride: { allowedOrigins: [base], allowedPathPrefixes: ['/', '/member'], allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'] },
      }),
    ).rejects.toThrow(/stuck: cannot find the control/)
  })

  it('stops at the step budget rather than looping forever', async () => {
    const store = await mkdtemp(join(tmpdir(), 'disc-'))
    const loop: ProposedAction = {
      kind: 'act', action: 'click', intent: 'click forever',
      target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
    }
    const model = new ScriptedModel([loop, loop, loop, loop, loop, loop])
    await expect(
      runDiscovery({
        goal: 'g', entryPoint: base + '/member/search', model, storeRoot: store,
        headless: true, maxSteps: 3,
        policyOverride: { allowedOrigins: [base], allowedPathPrefixes: ['/', '/member'], allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'] },
      }),
    ).rejects.toThrow(/step budget/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL — cannot resolve `../src/discover/loop.js`.

- [ ] **Step 3: Write `src/evidence/recorder.ts`**

```ts
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export class Recorder {
  readonly dir: string
  private readonly timeline: string

  constructor(storeRoot: string, readonly runId: string) {
    this.dir = join(storeRoot, 'runs', runId)
    this.timeline = join(this.dir, 'timeline.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'evidence'), { recursive: true })
  }

  /** Append-only. A crash mid-run leaves a readable file rather than a corrupt one,
   *  and this single file is simultaneously the debug log, the audit trail and the
   *  evidence artifact. */
  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    await appendFile(this.timeline, JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n', 'utf8')
  }

  evidencePath(label: string, ext: string): string {
    return join(this.dir, 'evidence', `${label}.${ext}`)
  }

  async shot(surface: { screenshot(p: string): Promise<void> }, label: string): Promise<string> {
    const p = this.evidencePath(label, 'png')
    await surface.screenshot(p)
    return p
  }

  async dom(surface: { domSnapshot(p: string): Promise<void> }, label: string): Promise<string> {
    const p = this.evidencePath(label, 'html')
    await surface.domSnapshot(p)
    return p
  }
}
```

- [ ] **Step 4: Write `src/discover/model.ts`**

```ts
import type { ActionKind, TargetDescriptor } from '../capability/schema.js'
import type { Observation } from '../surface/types.js'

export interface ProposeInput {
  goal: string
  observation: Observation
  history: string[]
}

export type ProposedAction =
  | { kind: 'act'; action: ActionKind; target: TargetDescriptor; value?: string; intent: string }
  | { kind: 'extract'; name: string; as: 'string' | 'number' | 'date'; from: TargetDescriptor; intent: string }
  | { kind: 'done'; summary: string }
  | { kind: 'stuck'; why: string }

export interface ModelClient {
  readonly name: string
  propose(input: ProposeInput): Promise<ProposedAction>
}

/** Injected into replay tests. If replay ever reaches for a model, the test fails
 *  loudly rather than silently costing money and determinism. */
export class ThrowingModel implements ModelClient {
  readonly name = 'throwing'
  async propose(): Promise<ProposedAction> {
    throw new Error('a model was called during replay — the decision loop must be model-free')
  }
}

export class OpenRouterModel implements ModelClient {
  readonly name: string
  constructor(
    private readonly apiKey = process.env.OPENROUTER_API_KEY ?? '',
    model = process.env.DISCOVERY_MODEL ?? 'anthropic/claude-opus-4.1',
  ) {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not set')
    this.name = model
  }

  async propose(input: ProposeInput): Promise<ProposedAction> {
    const { SYSTEM_PROMPT, renderObservation } = await import('./prompt.js')
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.name,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `GOAL: ${input.goal}\n\nSTEPS SO FAR:\n${input.history.join('\n') || '(none)'}\n\nCURRENT SCREEN:\n${renderObservation(input.observation)}`,
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    const text = body.choices[0]?.message.content ?? ''
    return JSON.parse(text) as ProposedAction
  }
}
```

- [ ] **Step 5: Write `src/discover/prompt.ts`**

```ts
import type { Observation } from '../surface/types.js'

export const SYSTEM_PROMPT = `You operate a legacy banking back-office web application by describing one
action at a time. You never see HTML or CSS. You see a list of controls, each with a role, an accessible
name, the label text next to it, and the frame it lives in.

Reply with ONE JSON object and nothing else. Valid shapes:

{"kind":"act","action":"fill"|"click"|"navigate"|"dismiss","intent":"<short human sentence>",
 "target":{"role":"<role>","name":"<accessible name or label>","framePath":[...],"fallbacks":[]},
 "value":"<only for fill>"}

{"kind":"extract","name":"<outputFieldName>","as":"string"|"number"|"date",
 "intent":"<short human sentence>","from":{"role":"table","name":"","framePath":[...],"fallbacks":[]}}

{"kind":"done","summary":"<what was achieved>"}

{"kind":"stuck","why":"<what is blocking you>"}

Rules:
- Identify controls by role and by the visible label next to them. Never invent a control that is
  not in the list.
- One action per reply. Do not batch.
- If the screen shows an error, a "no record found", or a dialog you do not recognise, and you cannot
  proceed safely, reply with "stuck" and say why. Do not guess.
- When the goal's information is visible on screen, "extract" it, then reply "done".`

export function renderObservation(o: Observation): string {
  const lines: string[] = [`URL: ${o.url}`, `TITLE: ${o.title}`]
  for (const f of o.frames) {
    lines.push(`\n--- FRAME [${f.path.join('/') || 'root'}] ---`)
    lines.push('TEXT: ' + f.text.replace(/\s+/g, ' ').slice(0, 800))
    lines.push('CONTROLS:')
    for (const n of f.nodes) {
      lines.push(`  - role=${n.role} name=${JSON.stringify(n.name)} label=${JSON.stringify(n.labelText ?? '')}`)
    }
  }
  return lines.join('\n')
}
```

- [ ] **Step 6: Write `src/discover/loop.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { ActionKind, TargetDescriptor } from '../capability/schema.js'
import { loadPolicy, type PolicyConfig } from '../policy/allowlist.js'
import { WebSurface } from '../surface/web.js'
import { Recorder } from '../evidence/recorder.js'
import type { ModelClient } from './model.js'

export interface TraceStep {
  intent: string
  action: ActionKind
  target: TargetDescriptor
  resolvedVia: string
  value?: string
  valueLiteral?: string
  urlAfter: string
  textAfter: string
}

export interface Trace {
  goal: string
  runId: string
  entryPoint: string
  model: string
  steps: TraceStep[]
  extracted: Record<string, { value: string; as: string; from: TargetDescriptor }>
  observedOutcomes: { text: string; url: string }[]
  finalText: string
}

export interface DiscoveryOptions {
  goal: string
  entryPoint: string
  model: ModelClient
  storeRoot: string
  headless?: boolean
  maxSteps?: number
  policyOverride?: PolicyConfig
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<Trace> {
  const policy = opts.policyOverride ?? (await loadPolicy())
  const runId = `disc_${randomUUID().slice(0, 8)}`
  const rec = new Recorder(opts.storeRoot, runId)
  await rec.init()

  const surface = new WebSurface(policy, opts.headless ?? false)
  await surface.start()
  // Discovery is exploratory and attended by definition, so it runs approved.
  // Nothing here is unattended; a person launched it and is watching.
  surface.setContext({ approvalState: 'approved', leaseHeld: true })

  const trace: Trace = {
    goal: opts.goal, runId, entryPoint: opts.entryPoint, model: opts.model.name,
    steps: [], extracted: {}, observedOutcomes: [], finalText: '',
  }
  const history: string[] = []
  const maxSteps = opts.maxSteps ?? 15

  try {
    await rec.event('discovery.start', { goal: opts.goal, entryPoint: opts.entryPoint, model: opts.model.name })
    await surface.open(opts.entryPoint)

    for (let i = 0; i < maxSteps; i++) {
      const observation = await surface.observe()
      trace.observedOutcomes.push({ text: observation.frames.map((f) => f.text).join('\n'), url: observation.url })

      const proposal = await opts.model.propose({ goal: opts.goal, observation, history })
      await rec.event('model.proposal', { step: i, proposal })

      if (proposal.kind === 'stuck') {
        await rec.shot(surface, `stuck-${i}`)
        await rec.dom(surface, `stuck-${i}`)
        throw new Error(`stuck: ${proposal.why}`)
      }

      if (proposal.kind === 'done') {
        trace.finalText = observation.frames.map((f) => f.text).join('\n')
        await rec.event('discovery.done', { summary: proposal.summary })
        await rec.shot(surface, 'final')
        return trace
      }

      if (proposal.kind === 'extract') {
        const text = await surface.readText(proposal.from)
        trace.extracted[proposal.name] = { value: text, as: proposal.as, from: proposal.from }
        history.push(`extract ${proposal.name}`)
        await rec.event('discovery.extract', { name: proposal.name })
        continue
      }

      const resolution = await surface.resolve(proposal.target)
      if (resolution.kind !== 'one') {
        await rec.shot(surface, `unresolved-${i}`)
        history.push(`FAILED to resolve ${JSON.stringify(proposal.target)} (${resolution.kind})`)
        await rec.event('discovery.unresolved', { step: i, resolution })
        continue
      }

      await surface.act(proposal.action, resolution.node, proposal.value)
      const after = await surface.observe()

      trace.steps.push({
        intent: proposal.intent,
        action: proposal.action,
        target: proposal.target,
        resolvedVia: resolution.via,
        value: proposal.value,
        valueLiteral: proposal.value,
        urlAfter: after.url,
        textAfter: after.frames.map((f) => f.text).join('\n'),
      })
      history.push(`${proposal.action} ${JSON.stringify(proposal.target.name ?? '')} -> ${after.url}`)
      await rec.event('discovery.acted', { step: i, action: proposal.action, via: resolution.via })
    }

    await rec.shot(surface, 'budget-exhausted')
    throw new Error(`step budget of ${maxSteps} exhausted without reaching the goal`)
  } finally {
    await surface.close()
  }
}
```

- [ ] **Step 7: Write `src/cli/discover.ts`**

```ts
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
```

- [ ] **Step 8: Run the discovery test to verify it passes**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS, 3 tests. (`src/cli/discover.ts` imports `compile`, which lands in Task 7; the test does not import the CLI, so it passes now.)

- [ ] **Step 9: Commit**

```bash
git add src/discover src/evidence src/cli/discover.ts tests/discover.test.ts
git commit -m "feat: LLM discovery loop over the accessibility surface with evidence recording"
```

---

### Task 7: Compiler — Trace to Capability

**Files:**
- Create: `src/compile/compile.ts`
- Test: `tests/compile.test.ts`

**Interfaces:**
- Consumes: `Trace` (Task 6); `Capability`, `CapabilitySchema` (Task 2).
- Produces: `compile(trace: Trace, opts: { key: string; params: Record<string,string>; version?: string }): Capability`.

- [ ] **Step 1: Write the failing test**

Create `tests/compile.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { CapabilitySchema } from '../src/capability/schema.js'
import type { Trace } from '../src/discover/loop.js'

const trace: Trace = {
  goal: 'look up member 40021 and read their savings balance',
  runId: 'disc_abc', entryPoint: 'http://localhost:4000/member/search', model: 'test-model',
  steps: [
    { intent: 'Type the member number', action: 'fill', resolvedVia: 'primary', value: '40021',
      target: { role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] },
      urlAfter: 'http://localhost:4000/member/search', textAfter: 'Member No.' },
    { intent: 'Submit the inquiry', action: 'click', resolvedVia: 'primary',
      target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
      urlAfter: 'http://localhost:4000/member/inquire', textAfter: 'Share Balance 1284.55 As Of 2026-09-17' },
  ],
  extracted: { savingsBalance: { value: 'Share Balance 1284.55', as: 'number', from: { role: 'table', name: '', framePath: [], fallbacks: [] } } },
  observedOutcomes: [{ text: 'Member No.', url: 'http://localhost:4000/member/search' }],
  finalText: 'Share Balance 1284.55 As Of 2026-09-17',
}

describe('compile', () => {
  it('produces a schema-valid capability', () => {
    const c = compile(trace, { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
    expect(() => CapabilitySchema.parse(c)).not.toThrow()
  })

  it('lifts a concrete value into a typed input parameter', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.inputs.properties.memberId).toBeDefined()
    expect(c.steps[0]!.value).toEqual({ fromInput: 'memberId' })
  })

  it('never leaves the concrete recorded value in a step', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(JSON.stringify(c.steps)).not.toContain('40021')
  })

  it('marks the lifted parameter as pii by default', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.inputs.properties.memberId!['x-sensitivity']).toBe('pii')
  })

  it('declares an output for each extraction', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.outputs.properties.savingsBalance).toEqual({ type: 'number' })
    expect(c.outputs.required).toContain('savingsBalance')
  })

  it('derives a success condition from the final screen', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.successCondition).toMatchObject({ kind: 'text-present' })
  })

  it('gives every step a checkpoint', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.steps.every((s) => s.checkpoint)).toBe(true)
  })

  it('classifies risk as mutate when any step mutates', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.risk.class).toBe('mutate')
  })

  it('starts at version 1.0.0 in draft', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.version).toBe('1.0.0')
    expect(c.approval.state).toBe('draft')
  })

  it('carries provenance naming the model and the discovery run', () => {
    const c = compile(trace, { key: 'k', params: { memberId: '40021' } })
    expect(c.provenance).toMatchObject({ discoveredBy: 'test-model', discoveryRunId: 'disc_abc' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/compile.test.ts`
Expected: FAIL — cannot resolve `../src/compile/compile.js`.

- [ ] **Step 3: Write `src/compile/compile.ts`**

```ts
import { classifyAction } from '../policy/allowlist.js'
import { CapabilitySchema, type Capability, type Checkpoint, type Step, type BusinessOutcome } from '../capability/schema.js'
import type { Trace, TraceStep } from '../discover/loop.js'

/** Runtime conditions worth declaring as outcomes when discovery happened to see
 *  them. Detectors are authored here, at compile time, and then only ever matched
 *  at replay — the model never interprets a result at run time. */
const KNOWN_OUTCOMES: { code: string; text: string; message: string }[] = [
  { code: 'MEMBER_NOT_FOUND', text: 'No record found', message: 'No member exists with that number.' },
  { code: 'ACCOUNT_RESTRICTED', text: 'Access restricted', message: 'This member requires elevated entitlements.' },
]

/** The most distinctive short line on the final screen becomes the success
 *  condition: a phrase that appeared only after the last action is evidence the
 *  last action worked, which is exactly what a checkpoint must assert. */
function distinctiveLine(finalText: string, priorText: string): string {
  const prior = new Set(priorText.split('\n').map((l) => l.trim()))
  const candidates = finalText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && l.length <= 60 && !prior.has(l))
  return candidates[0] ?? finalText.trim().slice(0, 40)
}

function checkpointFor(step: TraceStep, prior: string): Checkpoint {
  if (step.action === 'fill') {
    return { kind: 'field-has-value', role: step.target.role, name: step.target.name ?? '', framePath: step.target.framePath }
  }
  return { kind: 'text-present', text: distinctiveLine(step.textAfter, prior), framePath: step.target.framePath }
}

export function compile(
  trace: Trace,
  opts: { key: string; params: Record<string, string>; version?: string },
): Capability {
  // Invert the supplied params so a recorded literal can be lifted back into the
  // parameter it came from. Longest first, so "40021" wins over "4".
  const byValue = Object.entries(opts.params).sort((a, b) => b[1].length - a[1].length)

  const steps: Step[] = trace.steps.map((s, i) => {
    const prior = i === 0 ? '' : trace.steps[i - 1]!.textAfter
    const match = s.value ? byValue.find(([, v]) => v === s.value) : undefined

    const step: Step = {
      id: `s${i + 1}`,
      intent: s.intent,
      action: s.action,
      target: {
        ...s.target,
        fallbacks: s.target.fallbacks.length
          ? s.target.fallbacks
          : s.target.role === 'textbox'
            ? [{ strategy: 'nth-input-in-form', form: 0, index: 0 }]
            : [],
      },
      checkpoint: checkpointFor(s, prior),
      onError: [
        { when: 'dialog-present', match: 'Message of the Day', do: 'dismiss' },
        { when: 'timeout', do: 'retry', max: 2, backoffMs: 500 },
        { when: 'session-expired', do: 'reauth' },
      ],
      timeoutMs: 8000,
    }

    if (s.value !== undefined) {
      step.value = match ? { fromInput: match[0] } : { literal: s.value }
    }
    return step
  })

  const inputs: Capability['inputs'] = { type: 'object', required: [], properties: {} }
  for (const [name, value] of Object.entries(opts.params)) {
    inputs.required.push(name)
    inputs.properties[name] = {
      type: 'string',
      pattern: /^\d+$/.test(value) ? `^[0-9]{${value.length}}$` : undefined,
      // Anything a caller supplies per invocation is treated as identifying data
      // until a human reviewing the artifact says otherwise. Over-redacting is
      // recoverable; under-redacting regulated data is not.
      'x-sensitivity': 'pii',
    }
  }

  const outputs: Capability['outputs'] = { type: 'object', required: [], properties: {} }
  const extractSteps: Step[] = []
  let n = steps.length
  for (const [name, e] of Object.entries(trace.extracted)) {
    outputs.required.push(name)
    outputs.properties[name] = { type: e.as === 'number' ? 'number' : 'string' }
    extractSteps.push({
      id: `s${++n}`,
      intent: `Read ${name} from the result screen`,
      action: 'read',
      target: e.from,
      extract: { into: name, as: e.as as 'string' | 'number' | 'date' },
      checkpoint: { kind: 'text-present', text: distinctiveLine(trace.finalText, ''), framePath: e.from.framePath },
      onError: [{ when: 'timeout', do: 'retry', max: 2, backoffMs: 500 }],
      timeoutMs: 8000,
    })
  }

  const businessOutcomes: BusinessOutcome[] = KNOWN_OUTCOMES.map((o) => ({
    code: o.code,
    detect: { kind: 'text-present', text: o.text } as Checkpoint,
    terminal: true,
    message: o.message,
  }))

  const capability: Capability = {
    apiVersion: 'capability/v1',
    key: opts.key,
    version: opts.version ?? '1.0.0',
    title: trace.goal,
    description: `Discovered from the goal: ${trace.goal}`,
    surface: { kind: 'web' },
    vendor: { product: opts.key.split('/')[0] ?? 'unknown' },
    inputs,
    outputs,
    steps: [...steps, ...extractSteps],
    successCondition: { kind: 'text-present', text: distinctiveLine(trace.finalText, trace.steps[0]?.textAfter ?? '') },
    businessOutcomes,
    risk: {
      class: trace.steps.some((s) => classifyAction(s.action) === 'mutate') ? 'mutate' : 'read',
      irreversible: false,
      requiresApproval: false,
    },
    provenance: {
      discoveredBy: trace.model,
      discoveryRunId: trace.runId,
      recordedAt: new Date().toISOString(),
      humanEdits: [],
    },
    approval: { state: 'draft', replayStats: { attempts: 0, successes: 0, lastFailure: null } },
  }

  return CapabilitySchema.parse(JSON.parse(JSON.stringify(capability)))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/compile.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compile tests/compile.test.ts
git commit -m "feat: compiler lifting a trace into a parameterised versioned capability"
```

---

### Task 8: Control lease and intervention queue

**Files:**
- Create: `src/control/lease.ts`, `src/control/interventions.ts`
- Create: `src/cli/operator.ts`
- Test: `tests/control.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond Node built-ins.
- Produces:
  - `interface Lease { sessionId: string; holder: string; token: number; acquiredAt: string }`.
  - `class LeaseStore` with `current(sessionId)`, `acquire(sessionId, holder)`, `release(sessionId, to)`, `holds(sessionId, holder, token)`.
  - `interface Intervention { id: string; runId: string; capability: string; step: string; reason: string; evidenceDir: string; redactedParams: Record<string, unknown>; state: 'open'|'resolved'; note?: string; humanActions?: { urlBefore: string; urlAfter: string; note: string }[] }`.
  - `class InterventionStore` with `raise(i)`, `get(id)`, `list()`, `resolve(id, note, humanActions)`.

- [ ] **Step 1: Write the failing test**

Create `tests/control.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LeaseStore } from '../src/control/lease.js'
import { InterventionStore } from '../src/control/interventions.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ctl-')) })

describe('LeaseStore', () => {
  it('grants a lease with an incrementing fencing token', async () => {
    const s = new LeaseStore(dir)
    const a = await s.acquire('sess1', 'agent')
    const b = await s.release('sess1', 'human:op-7')
    expect(b.token).toBe(a.token + 1)
    expect(b.holder).toBe('human:op-7')
  })

  it('recognises the current holder with the current token', async () => {
    const s = new LeaseStore(dir)
    const l = await s.acquire('sess1', 'agent')
    expect(await s.holds('sess1', 'agent', l.token)).toBe(true)
  })

  it('rejects a stale token even from the right holder', async () => {
    const s = new LeaseStore(dir)
    const l = await s.acquire('sess1', 'agent')
    await s.release('sess1', 'human:op-7')
    await s.release('sess1', 'agent')
    expect(await s.holds('sess1', 'agent', l.token)).toBe(false)
  })

  it('rejects the wrong holder holding the current token', async () => {
    const s = new LeaseStore(dir)
    const l = await s.acquire('sess1', 'agent')
    expect(await s.holds('sess1', 'human:op-7', l.token)).toBe(false)
  })
})

describe('InterventionStore', () => {
  it('raises and lists an open intervention', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({
      runId: 'r1', capability: 'k@1.0.0', step: 's3',
      reason: 'unknown_dialog', evidenceDir: 'store/runs/r1/evidence',
      redactedParams: { memberId: 'sha256:abc' },
    })
    expect(iv.id).toMatch(/^iv_/)
    expect((await s.list()).map((x) => x.id)).toContain(iv.id)
    expect((await s.get(iv.id)).state).toBe('open')
  })

  it('records what the human did on resolve', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({
      runId: 'r1', capability: 'k@1.0.0', step: 's3', reason: 'unknown_dialog',
      evidenceDir: 'd', redactedParams: {},
    })
    await s.resolve(iv.id, 'cleared the notice', [{ urlBefore: 'a', urlAfter: 'b', note: 'clicked Acknowledge' }])
    const got = await s.get(iv.id)
    expect(got.state).toBe('resolved')
    expect(got.note).toBe('cleared the notice')
    expect(got.humanActions?.[0]?.note).toBe('clicked Acknowledge')
  })

  it('never stores an unredacted parameter it was not given', async () => {
    const s = new InterventionStore(dir)
    const iv = await s.raise({
      runId: 'r1', capability: 'k@1.0.0', step: 's3', reason: 'r', evidenceDir: 'd',
      redactedParams: { memberId: 'sha256:abc123def456' },
    })
    expect(JSON.stringify(await s.get(iv.id))).not.toContain('40021')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/control.test.ts`
Expected: FAIL — cannot resolve `../src/control/lease.js`.

- [ ] **Step 3: Write `src/control/lease.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Lease {
  sessionId: string
  holder: string
  token: number
  acquiredAt: string
}

/** A fencing token, not just a holder name.
 *
 *  Without it, "pause and resume" is a naming convention: a late write from the
 *  previous holder still lands. Every action carries the token it believes is
 *  current, and a stale token is refused, so exactly one party can act at a time. */
export class LeaseStore {
  constructor(private readonly root: string) {}

  private path(sessionId: string): string {
    return join(this.root, 'control', `${sessionId}.lease.json`)
  }

  async current(sessionId: string): Promise<Lease | null> {
    try {
      return JSON.parse(await readFile(this.path(sessionId), 'utf8')) as Lease
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  private async write(l: Lease): Promise<Lease> {
    await mkdir(join(this.root, 'control'), { recursive: true })
    await writeFile(this.path(l.sessionId), JSON.stringify(l, null, 2) + '\n', 'utf8')
    return l
  }

  async acquire(sessionId: string, holder: string): Promise<Lease> {
    const cur = await this.current(sessionId)
    return this.write({ sessionId, holder, token: (cur?.token ?? 0) + 1, acquiredAt: new Date().toISOString() })
  }

  async release(sessionId: string, to: string): Promise<Lease> {
    return this.acquire(sessionId, to)
  }

  async holds(sessionId: string, holder: string, token: number): Promise<boolean> {
    const cur = await this.current(sessionId)
    return !!cur && cur.holder === holder && cur.token === token
  }
}
```

- [ ] **Step 4: Write `src/control/interventions.ts`**

```ts
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface HumanAction {
  urlBefore: string
  urlAfter: string
  note: string
}

export interface Intervention {
  id: string
  runId: string
  capability: string
  step: string
  reason: string
  evidenceDir: string
  redactedParams: Record<string, unknown>
  state: 'open' | 'resolved'
  raisedAt: string
  note?: string
  humanActions?: HumanAction[]
}

export class InterventionStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, 'interventions')
  }
  private path(id: string): string {
    return join(this.dir(), `${id}.json`)
  }

  async raise(i: Omit<Intervention, 'id' | 'state' | 'raisedAt'>): Promise<Intervention> {
    const iv: Intervention = { ...i, id: `iv_${randomUUID().slice(0, 6)}`, state: 'open', raisedAt: new Date().toISOString() }
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.path(iv.id), JSON.stringify(iv, null, 2) + '\n', 'utf8')
    return iv
  }

  async get(id: string): Promise<Intervention> {
    return JSON.parse(await readFile(this.path(id), 'utf8')) as Intervention
  }

  async list(): Promise<Intervention[]> {
    try {
      const names = await readdir(this.dir())
      return await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.replace('.json', ''))))
    } catch {
      return []
    }
  }

  async resolve(id: string, note: string, humanActions: HumanAction[] = []): Promise<Intervention> {
    const iv = await this.get(id)
    const next: Intervention = { ...iv, state: 'resolved', note, humanActions }
    await writeFile(this.path(id), JSON.stringify(next, null, 2) + '\n', 'utf8')
    return next
  }
}
```

- [ ] **Step 5: Write `src/cli/operator.ts`**

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/control.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/control src/cli/operator.ts tests/control.test.ts
git commit -m "feat: fencing-token control lease and intervention queue with a CLI operator surface"
```

---

### Task 9: Replay — deterministic execution with the four-way result

**Files:**
- Create: `src/replay/outcomes.ts`, `src/replay/recovery.ts`, `src/replay/execute.ts`
- Create: `src/cli/replay.ts`
- Test: `tests/replay.test.ts`

**Interfaces:**
- Consumes: `FileStore` (3), `gate`/`redactParams` (4), `WebSurface`/`PolicyError` (5), `Recorder` (6), `LeaseStore`/`InterventionStore` (8).
- Produces:
  - `detectBusinessOutcome(surface, outcomes): Promise<BusinessOutcome | null>`.
  - `applyRecovery(surface, rungs, ctx): Promise<'recovered' | 'not-applicable'>`.
  - `replay(opts: ReplayOptions): Promise<ReplayResult>` where `ReplayOptions = { ref: string; tenant: string; params: Record<string, unknown>; storeRoot: string; headless?: boolean; policyOverride?: PolicyConfig; entryPointOverride?: string; waitForHuman?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `tests/replay.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../target-app/server.js'
import { FileStore } from '../src/capability/store.js'
import { compile } from '../src/compile/compile.js'
import { replay } from '../src/replay/execute.js'
import type { Trace } from '../src/discover/loop.js'
import type { PolicyConfig } from '../src/policy/allowlist.js'

const PORT = 4114
const base = `http://localhost:${PORT}`
const policy: PolicyConfig = {
  allowedOrigins: [base],
  allowedPathPrefixes: ['/', '/nav', '/member'],
  allowedActions: ['navigate', 'click', 'fill', 'read', 'waitFor', 'dismiss'],
}

const trace = (): Trace => ({
  goal: 'look up a member savings balance', runId: 'disc_test',
  entryPoint: base + '/member/search', model: 'test-model',
  steps: [
    { intent: 'Type the member number', action: 'fill', resolvedVia: 'primary', value: '40021',
      target: { role: 'textbox', name: 'Member No.', framePath: [], fallbacks: [] },
      urlAfter: base + '/member/search', textAfter: 'Member No.' },
    { intent: 'Submit the inquiry', action: 'click', resolvedVia: 'primary',
      target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
      urlAfter: base + '/member/inquire', textAfter: 'Member A. Whitfield (40021)\nShare Balance\n1284.55' },
  ],
  extracted: { savingsBalance: { value: 'Share Balance 1284.55', as: 'number', from: { role: 'table', name: '', framePath: [], fallbacks: [] } } },
  observedOutcomes: [], finalText: 'Member A. Whitfield (40021)\nShare Balance\n1284.55',
})

let server: Server
let dir: string
const REF = 'quest-core/member.savings_balance@1.0.0'

beforeAll(async () => {
  server = createServer().listen(PORT)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'replay-'))
  const store = new FileStore(dir)
  const cap = compile(trace(), { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
  // Approved, because these tests exercise replay rather than the approval gate.
  await store.saveCapability({ ...cap, approval: { ...cap.approval, state: 'approved' } })
  await store.saveBinding({
    tenant: 'firstvalley-cu', capability: REF, entryPoint: base + '/member/search',
    overrides: {}, driftLog: [],
  })
})

const run = (params: Record<string, unknown>, entry?: string) =>
  replay({ ref: REF, tenant: 'firstvalley-cu', params, storeRoot: dir, headless: true, policyOverride: policy, entryPointOverride: entry })

describe('replay', () => {
  it('succeeds and returns the declared output for a known member', async () => {
    const r = await run({ memberId: '40021' })
    expect(r.status).toBe('success')
    if (r.status === 'success') expect(String(r.outputs.savingsBalance)).toContain('1284.55')
  }, 60_000)

  it('returns a business outcome, not a failure, for an unknown member', async () => {
    const r = await run({ memberId: '99999' })
    expect(r.status).toBe('business_outcome')
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_NOT_FOUND')
  }, 60_000)

  it('returns a distinct business outcome for a restricted member', async () => {
    const r = await run({ memberId: '40022' })
    expect(r.status).toBe('business_outcome')
    if (r.status === 'business_outcome') expect(r.code).toBe('ACCOUNT_RESTRICTED')
  }, 60_000)

  it('fails with input_invalid before touching the surface when params break the schema', async () => {
    const r = await run({ memberId: 'not-a-number' })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.class).toBe('input_invalid')
  }, 60_000)

  it('recovers from an injected session timeout and still completes', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=session-timeout')
    expect(r.status).toBe('success')
  }, 60_000)

  it('recovers from a known interstitial without surfacing it', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=motd')
    expect(r.status).toBe('success')
  }, 60_000)

  it('blocks on an unrecognised dialog rather than guessing', async () => {
    const r = await run({ memberId: '40021' }, base + '/member/search?inject=unknown-dialog')
    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.interventionId).toMatch(/^iv_/)
  }, 60_000)

  it('accumulates replay stats on the capability', async () => {
    await run({ memberId: '40021' })
    const c = await new FileStore(dir).loadCapability(REF)
    expect(c.approval.replayStats.attempts).toBe(1)
    expect(c.approval.replayStats.successes).toBe(1)
  }, 60_000)

  it('holds rather than acts when the capability is still a draft', async () => {
    const store = new FileStore(dir)
    const c = await store.loadCapability(REF)
    await store.saveCapability({ ...c, approval: { ...c.approval, state: 'draft' } })
    const r = await run({ memberId: '40021' })
    expect(r.status).toBe('blocked')
  }, 60_000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replay.test.ts`
Expected: FAIL — cannot resolve `../src/replay/execute.js`.

- [ ] **Step 3: Write `src/replay/outcomes.ts`**

```ts
import type { BusinessOutcome, Checkpoint } from '../capability/schema.js'

export interface CheckpointCapable {
  checkpointHolds(c: Checkpoint): Promise<{ ok: boolean; observed: string }>
}

/** Detectors are matched, never interpreted.
 *
 *  An earlier generation of this idea sent the result to a model and asked what it
 *  meant. That is the thing replay must not do: the model authored these detectors
 *  at compile time, and at run time they are deterministic pattern matches. */
export async function detectBusinessOutcome(
  surface: CheckpointCapable,
  outcomes: BusinessOutcome[],
): Promise<BusinessOutcome | null> {
  for (const o of outcomes) {
    const { ok } = await surface.checkpointHolds(o.detect)
    if (ok) return o
  }
  return null
}
```

- [ ] **Step 4: Write `src/replay/recovery.ts`**

```ts
import type { RecoveryRung } from '../capability/schema.js'
import type { WebSurface } from '../surface/web.js'

export type RecoveryResult = 'recovered' | 'not-applicable'

/** The three piles, sorted at authoring time rather than at run time.
 *
 *  Recovery is declared on the step, so the system is never deciding *how* to
 *  recover while it runs — it is executing a recovery someone reviewed. */
export async function applyRecovery(
  surface: WebSurface,
  rungs: RecoveryRung[],
  ctx: { entryPoint: string },
): Promise<RecoveryResult> {
  for (const rung of rungs) {
    if (rung.when === 'dialog-present') {
      const hit = await surface.checkpointHolds({ kind: 'text-present', text: rung.match })
      if (!hit.ok) continue
      const btn = await surface.resolve({ role: 'button', name: 'Acknowledge', framePath: [], fallbacks: [] })
      if (btn.kind === 'one') {
        await surface.act('dismiss', btn.node)
        return 'recovered'
      }
    }

    if (rung.when === 'session-expired') {
      const expired = await surface.checkpointHolds({ kind: 'text-present', text: 'Your session has expired' })
      if (!expired.ok) continue
      // Re-auth is stubbed at a real seam: the target app stubs login, so this
      // returns to the entry point. A production surface would invoke a `login`
      // capability here as a precondition.
      await surface.open(ctx.entryPoint)
      return 'recovered'
    }

    if (rung.when === 'timeout') {
      await new Promise((r) => setTimeout(r, rung.backoffMs))
      return 'recovered'
    }
  }
  return 'not-applicable'
}
```

- [ ] **Step 5: Write `src/replay/execute.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FileStore } from '../capability/store.js'
import type { Capability, ReplayResult, Step } from '../capability/schema.js'
import { loadPolicy, type PolicyConfig } from '../policy/allowlist.js'
import { redactParams } from '../policy/redact.js'
import { WebSurface, PolicyError } from '../surface/web.js'
import { Recorder } from '../evidence/recorder.js'
import { LeaseStore } from '../control/lease.js'
import { InterventionStore } from '../control/interventions.js'
import { detectBusinessOutcome } from './outcomes.js'
import { applyRecovery } from './recovery.js'

export interface ReplayOptions {
  ref: string
  tenant: string
  params: Record<string, unknown>
  storeRoot: string
  headless?: boolean
  policyOverride?: PolicyConfig
  entryPointOverride?: string
}

function validatorFor(c: Capability): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, prop] of Object.entries(c.inputs.properties)) {
    let s: z.ZodString = z.string()
    const pattern = prop.pattern as string | undefined
    if (pattern) s = s.regex(new RegExp(pattern))
    shape[name] = c.inputs.required.includes(name) ? s : s.optional()
  }
  return z.object(shape)
}

function valueFor(step: Step, params: Record<string, unknown>): string | undefined {
  if (!step.value) return undefined
  if ('literal' in step.value) return step.value.literal
  return String(params[step.value.fromInput] ?? '')
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const store = new FileStore(opts.storeRoot)
  const policy = opts.policyOverride ?? (await loadPolicy())
  const runId = `rep_${randomUUID().slice(0, 8)}`
  const sessionId = `sess_${runId}`
  const rec = new Recorder(opts.storeRoot, runId)
  await rec.init()

  const { capability, binding } = await store.resolveForTenant(opts.ref, opts.tenant)
  const entryPoint = opts.entryPointOverride ?? binding?.entryPoint
  const redacted = redactParams(opts.params as Record<string, unknown>, capability.inputs)
  await rec.event('replay.start', { ref: opts.ref, tenant: opts.tenant, params: redacted, runId })

  const parsed = validatorFor(capability).safeParse(opts.params)
  if (!parsed.success) {
    const r: ReplayResult = {
      status: 'failed', step: '(inputs)', expected: 'parameters matching the declared input schema',
      observed: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      class: 'input_invalid', evidence: rec.dir,
    }
    await rec.event('replay.result', { result: r })
    await store.recordReplayAttempt(opts.ref, false, 'input_invalid')
    return r
  }
  if (!entryPoint) {
    const r: ReplayResult = {
      status: 'failed', step: '(binding)', expected: `a binding for tenant ${opts.tenant}`,
      observed: 'no binding and no entry point override', class: 'surface_error', evidence: rec.dir,
    }
    await rec.event('replay.result', { result: r })
    return r
  }

  const leases = new LeaseStore(opts.storeRoot)
  const interventions = new InterventionStore(opts.storeRoot)
  let lease = await leases.acquire(sessionId, 'agent')

  const surface = new WebSurface(policy, opts.headless ?? false)
  await surface.start()
  surface.setContext({ approvalState: capability.approval.state, leaseHeld: true })

  const outputs: Record<string, unknown> = {}

  const block = async (step: string, reason: string): Promise<ReplayResult> => {
    await rec.shot(surface, `blocked-${step}`)
    await rec.dom(surface, `blocked-${step}`)
    lease = await leases.release(sessionId, 'human:operator')
    const iv = await interventions.raise({
      runId, capability: opts.ref, step, reason,
      evidenceDir: rec.dir, redactedParams: redacted,
    })
    await rec.event('replay.blocked', { step, reason, interventionId: iv.id, leaseToken: lease.token })
    return { status: 'blocked', interventionId: iv.id, reason, evidence: rec.dir }
  }

  try {
    await surface.open(entryPoint)

    for (const step of capability.steps) {
      await rec.event('step.start', { id: step.id, intent: step.intent, action: step.action })

      // A declared outcome can appear at any point, so it is checked before each
      // step rather than only at the end. "No record found" is an answer, and an
      // answer should not have to wait for the remaining steps to fail.
      const outcome = await detectBusinessOutcome(surface, capability.businessOutcomes)
      if (outcome) {
        const r: ReplayResult = {
          status: 'business_outcome', code: outcome.code,
          message: outcome.message ?? outcome.code, evidence: rec.dir,
        }
        await rec.event('replay.result', { result: r })
        await store.recordReplayAttempt(opts.ref, true, null)
        return r
      }

      if (step.action === 'read') {
        const text = await surface.readText(step.target!)
        if (step.extract) outputs[step.extract.into] = text
        await rec.event('step.extract', { id: step.id, into: step.extract?.into })
        continue
      }

      let resolution = await surface.resolve(step.target!)

      if (resolution.kind === 'none') {
        const recovered = await applyRecovery(surface, step.onError, { entryPoint })
        if (recovered === 'recovered') {
          await rec.event('step.recovered', { id: step.id })
          const again = await detectBusinessOutcome(surface, capability.businessOutcomes)
          if (again) {
            const r: ReplayResult = { status: 'business_outcome', code: again.code, message: again.message ?? again.code, evidence: rec.dir }
            await store.recordReplayAttempt(opts.ref, true, null)
            return r
          }
          resolution = await surface.resolve(step.target!)
        }
      }

      if (resolution.kind === 'ambiguous') {
        // Two candidates is never an action. On a read it is a hard failure; on a
        // mutate a person choosing between them is a legitimate intervention.
        if (capability.risk.class === 'mutate') return await block(step.id, `resolver_ambiguous:${resolution.count}`)
        const r: ReplayResult = {
          status: 'failed', step: step.id, expected: `exactly one ${step.target!.role} named "${step.target!.name}"`,
          observed: `${resolution.count} matches`, class: 'resolver_ambiguous', evidence: rec.dir,
        }
        await rec.event('replay.result', { result: r })
        await store.recordReplayAttempt(opts.ref, false, `resolver_ambiguous at ${step.id}`)
        return r
      }

      if (resolution.kind === 'none') {
        // Unknown means stop. An unrecognised screen is exactly where improvising
        // stops being automation and starts being a liability.
        return await block(step.id, 'unrecognised_state_or_missing_control')
      }

      if (resolution.via !== 'primary' && binding) {
        await store.recordDrift(opts.tenant, capability.key, step.id, resolution.via)
        await rec.event('step.drift', { id: step.id, via: resolution.via })
      }

      try {
        await surface.act(step.action, resolution.node, valueFor(step, opts.params as Record<string, unknown>))
      } catch (e) {
        if (e instanceof PolicyError && e.verdict === 'HOLD') return await block(step.id, e.reason)
        if (e instanceof PolicyError) {
          const r: ReplayResult = {
            status: 'failed', step: step.id, expected: 'an action permitted by policy',
            observed: e.reason, class: 'policy_denied', evidence: rec.dir,
          }
          await store.recordReplayAttempt(opts.ref, false, `policy_denied at ${step.id}`)
          return r
        }
        throw e
      }

      let cp = await surface.checkpointHolds(step.checkpoint)
      if (!cp.ok) {
        const outcomeNow = await detectBusinessOutcome(surface, capability.businessOutcomes)
        if (outcomeNow) {
          const r: ReplayResult = { status: 'business_outcome', code: outcomeNow.code, message: outcomeNow.message ?? outcomeNow.code, evidence: rec.dir }
          await rec.event('replay.result', { result: r })
          await store.recordReplayAttempt(opts.ref, true, null)
          return r
        }
        const recovered = await applyRecovery(surface, step.onError, { entryPoint })
        if (recovered === 'recovered') cp = await surface.checkpointHolds(step.checkpoint)
      }

      if (!cp.ok) {
        await rec.shot(surface, `failed-${step.id}`)
        await rec.dom(surface, `failed-${step.id}`)
        const r: ReplayResult = {
          status: 'failed', step: step.id, expected: JSON.stringify(step.checkpoint),
          observed: cp.observed, class: 'checkpoint_failed', evidence: rec.dir,
        }
        await rec.event('replay.result', { result: r })
        await store.recordReplayAttempt(opts.ref, false, `checkpoint_failed at ${step.id}`)
        return r
      }

      await rec.event('step.ok', { id: step.id })
    }

    const success = await surface.checkpointHolds(capability.successCondition)
    if (!success.ok) {
      await rec.shot(surface, 'failed-success-condition')
      const r: ReplayResult = {
        status: 'failed', step: '(successCondition)', expected: JSON.stringify(capability.successCondition),
        observed: success.observed, class: 'checkpoint_failed', evidence: rec.dir,
      }
      await store.recordReplayAttempt(opts.ref, false, 'success_condition_failed')
      return r
    }

    const r: ReplayResult = { status: 'success', outputs, evidence: rec.dir }
    await rec.event('replay.result', { result: { ...r, outputs: '[see run]' } })
    await store.recordReplayAttempt(opts.ref, true, null)
    return r
  } catch (e) {
    if (e instanceof PolicyError && e.verdict === 'HOLD') return await block('(surface)', e.reason)
    await rec.event('replay.error', { error: String(e) })
    const r: ReplayResult = {
      status: 'failed', step: '(run)', expected: 'the recorded flow to complete',
      observed: String(e), class: 'surface_error', evidence: rec.dir,
    }
    await store.recordReplayAttempt(opts.ref, false, String(e))
    return r
  } finally {
    await surface.close()
  }
}
```

- [ ] **Step 6: Write `src/cli/replay.ts`**

```ts
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
  const inject = process.argv.indexOf('--inject')
  const entry = inject >= 0
    ? `http://localhost:4000/member/search?inject=${process.argv[inject + 1]}`
    : undefined

  const result = await replay({
    ref: arg('capability'),
    tenant: arg('tenant', 'firstvalley-cu'),
    params: JSON.parse(arg('params', '{}')) as Record<string, unknown>,
    storeRoot: 'store',
    headless: process.env.HEADLESS === '1',
    entryPointOverride: entry,
  })

  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'failed') process.exitCode = 1
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/replay.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 8: Commit**

```bash
git add src/replay src/cli/replay.ts tests/replay.test.ts
git commit -m "feat: deterministic replay with a four-way result, declared outcomes and recovery rungs"
```

---

### Task 10: The model-absence proof and boundary enforcement

**Files:**
- Create: `tests/boundaries.test.ts`

**Interfaces:**
- Consumes: `ThrowingModel` (Task 6); the module tree.
- Produces: nothing importable — this task's deliverable is the guarantee itself.

- [ ] **Step 1: Write the failing test**

Create `tests/boundaries.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (p.endsWith('.ts')) out.push(p)
    }
  }
  await walk(dir)
  return out
}

describe('architectural boundaries', () => {
  it('no module outside src/surface/web.ts imports playwright', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder('src')) {
      if (f.replace(/\\/g, '/').endsWith('src/surface/web.ts')) continue
      const src = await readFile(f, 'utf8')
      if (/from ['"]playwright['"]/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('replay never imports discovery or a model', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder(join('src', 'replay'))) {
      const src = await readFile(f, 'utf8')
      if (/from ['"].*\/discover\//.test(src) || /from ['"].*model\.js['"]/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('the compiler is the only module that reads a trace', async () => {
    const offenders: string[] = []
    for (const f of await filesUnder('src')) {
      const norm = f.replace(/\\/g, '/')
      if (norm.endsWith('src/compile/compile.ts') || norm.startsWith('src/discover/') || norm.startsWith('src/cli/')) continue
      const src = await readFile(f, 'utf8')
      if (/\bTrace\b/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})

describe('ThrowingModel', () => {
  it('makes an accidental model call during replay loud rather than silent', async () => {
    const { ThrowingModel } = await import('../src/discover/model.js')
    await expect(new ThrowingModel().propose()).rejects.toThrow(/decision loop must be model-free/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails or passes honestly**

Run: `npx vitest run tests/boundaries.test.ts`
Expected: PASS if Tasks 1–9 respected the boundaries. If it FAILS, the offending import is a real violation — fix the import rather than the test.

- [ ] **Step 3: Commit**

```bash
git add tests/boundaries.test.ts
git commit -m "test: enforce the compile-time/run-time wall and the single Playwright import"
```

---

### Task 11: Capability catalog

**Files:**
- Create: `src/catalog/catalog.ts`, `src/cli/catalog.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `FileStore` (3), `Capability` (2), `replay` (9).
- Produces: `toolDefinition(c: Capability): ToolDefinition` where `ToolDefinition = { name: string; description: string; parameters: object; unattended: boolean }`; `buildCatalog(store): Promise<ToolDefinition[]>`.

- [ ] **Step 1: Write the failing test**

Create `tests/catalog.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/capability/store.js'
import { compile } from '../src/compile/compile.js'
import { buildCatalog, toolDefinition } from '../src/catalog/catalog.js'
import type { Trace } from '../src/discover/loop.js'

const trace: Trace = {
  goal: 'look up a member savings balance', runId: 'r', entryPoint: 'http://localhost:4000/member/search',
  model: 'm',
  steps: [{ intent: 'i', action: 'click', resolvedVia: 'primary',
    target: { role: 'button', name: 'Inquire', framePath: [], fallbacks: [] },
    urlAfter: 'http://localhost:4000/member/inquire', textAfter: 'Share Balance' }],
  extracted: { savingsBalance: { value: '1', as: 'number', from: { role: 'table', name: '', framePath: [], fallbacks: [] } } },
  observedOutcomes: [], finalText: 'Share Balance',
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cat-')) })

describe('catalog', () => {
  it('exposes a capability as a callable tool definition', async () => {
    const c = compile(trace, { key: 'quest-core/member.savings_balance', params: { memberId: '40021' } })
    const t = toolDefinition(c)
    expect(t.name).toBe('quest_core__member_savings_balance')
    expect(t.parameters).toMatchObject({ type: 'object', required: ['memberId'] })
    expect(t.description).toContain('savingsBalance')
  })

  it('marks a draft capability as attended-only', async () => {
    const c = compile(trace, { key: 'k/x', params: { memberId: '40021' } })
    expect(toolDefinition(c).unattended).toBe(false)
    expect(toolDefinition({ ...c, approval: { ...c.approval, state: 'approved' } }).unattended).toBe(true)
  })

  it('never leaks a recorded sample value into the tool description', async () => {
    const c = compile(trace, { key: 'k/x', params: { memberId: '40021' } })
    expect(JSON.stringify(toolDefinition(c))).not.toContain('40021')
  })

  it('lists every saved capability', async () => {
    const store = new FileStore(dir)
    await store.saveCapability(compile(trace, { key: 'a/one', params: { memberId: '40021' } }))
    await store.saveCapability(compile(trace, { key: 'b/two', params: { memberId: '40021' } }))
    expect((await buildCatalog(store)).map((t) => t.name).sort()).toEqual(['a__one', 'b__two'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — cannot resolve `../src/catalog/catalog.js`.

- [ ] **Step 3: Write `src/catalog/catalog.ts`**

```ts
import type { FileStore } from '../capability/store.js'
import type { Capability } from '../capability/schema.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  returns: Record<string, unknown>
  unattended: boolean
  ref: string
}

const toolName = (key: string): string => key.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+/g, '_')

/** A saved capability, rendered as something an agent can call by name.
 *
 *  Nothing here is generated: inputs and outputs were declared in the artifact at
 *  compile time, so the tool contract and the replay contract cannot drift apart. */
export function toolDefinition(c: Capability): ToolDefinition {
  const outs = Object.keys(c.outputs.properties).join(', ')
  return {
    name: toolName(c.key),
    ref: `${c.key}@${c.version}`,
    description: `${c.title}. Returns: ${outs || '(nothing)'}.`,
    parameters: {
      type: 'object',
      required: c.inputs.required,
      properties: Object.fromEntries(
        Object.entries(c.inputs.properties).map(([k, v]) => [
          k,
          { type: v.type, ...(v.pattern ? { pattern: v.pattern } : {}) },
        ]),
      ),
    },
    returns: c.outputs as unknown as Record<string, unknown>,
    // Autonomy is a permission a behaviour earns; the evidence is replay history.
    unattended: c.approval.state === 'approved',
  }
}

export async function buildCatalog(store: FileStore): Promise<ToolDefinition[]> {
  const caps = await store.listCapabilities()
  return caps.map(toolDefinition).sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Write `src/cli/catalog.ts`**

```ts
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
    if (!tool.unattended) console.error(`note: ${tool.ref} is a draft — attended invocation only`)
    const result = await replay({
      ref: tool.ref, tenant: 'firstvalley-cu', params: args, storeRoot: STORE,
      headless: process.env.HEADLESS === '1',
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(JSON.stringify(await buildCatalog(store), null, 2))
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/catalog src/cli/catalog.ts tests/catalog.test.ts
git commit -m "feat: capability catalog exposing artifacts as callable tool definitions"
```

---

### Task 12: The real discovery run, evidence capture, README and REPORT

**Files:**
- Create: `README.md`, `REPORT.md`
- Create: `evidence/` (copied from `store/runs/...`)
- Create: `store/bindings/firstvalley-cu/quest-core__member.savings_balance.json`
- Modify: `.gitignore` (stop ignoring the committed `evidence/` copy)

**Interfaces:**
- Consumes: everything.
- Produces: the submission.

- [ ] **Step 1: Start the target app and run the full test suite**

```bash
npm test
npm run target-app &
```
Expected: all tests green; target app on `http://localhost:4000`.

- [ ] **Step 2: Create the tenant binding**

```bash
mkdir -p store/bindings/firstvalley-cu
cat > store/bindings/firstvalley-cu/quest-core__member.savings_balance.json <<'JSON'
{
  "tenant": "firstvalley-cu",
  "capability": "quest-core/member.savings_balance@1.0.0",
  "entryPoint": "http://localhost:4000/member/search",
  "overrides": {},
  "driftLog": []
}
JSON
```

- [ ] **Step 3: Run the real LLM discovery run**

```bash
export OPENROUTER_API_KEY=...   # already in the environment
npm run discover -- \
  --goal "look up member 40021 and read their current savings balance" \
  --entry "http://localhost:4000/member/search" \
  --key "quest-core/member.savings_balance" \
  --params '{"memberId":"40021"}'
```
Expected: a `disc_*` run directory, a saved capability at `store/capabilities/quest-core/member.savings_balance/1.0.0.json`.
If the model gets stuck, read `store/runs/disc_*/timeline.jsonl` — the `model.proposal` events show what it saw and chose. Adjust `SYSTEM_PROMPT` and re-run; keep the failed run, it is legitimate evidence.

- [ ] **Step 4: Approve the capability so mutations may run unattended**

```bash
node --input-type=module -e "
import { FileStore } from './src/capability/store.js'
const s = new FileStore('store')
const ref = 'quest-core/member.savings_balance@1.0.0'
const c = await s.loadCapability(ref)
c.approval.state = 'approved'
c.approval.approvedBy = 'operator:local'
await s.saveCapability(c)
console.log('approved', ref)
" --experimental-strip-types 2>/dev/null || npx tsx -e "
import { FileStore } from './src/capability/store.js'
const s = new FileStore('store')
const ref = 'quest-core/member.savings_balance@1.0.0'
const c = await s.loadCapability(ref)
c.approval.state = 'approved'
c.approval.approvedBy = 'operator:local'
await s.saveCapability(c)
console.log('approved', ref)
"
```

- [ ] **Step 5: Run the five replay demonstrations**

```bash
R="--capability quest-core/member.savings_balance@1.0.0 --tenant firstvalley-cu"
npm run replay -- $R --params '{"memberId":"40021"}'                    # success
npm run replay -- $R --params '{"memberId":"99999"}'                    # MEMBER_NOT_FOUND
npm run replay -- $R --params '{"memberId":"40022"}'                    # ACCOUNT_RESTRICTED
npm run replay -- $R --params '{"memberId":"40021"}' --inject session-timeout   # recovers
npm run replay -- $R --params '{"memberId":"40021"}' --inject unknown-dialog    # blocked
npm run operator -- list
npm run operator -- resume iv_XXXXXX --note "cleared the compliance notice"
npm run catalog
```

- [ ] **Step 6: Copy the runs into `/evidence/` and un-ignore it**

```bash
mkdir -p evidence
cp -r store/runs/* evidence/
cp -r store/interventions evidence/interventions
cp store/capabilities/quest-core/member.savings_balance/1.0.0.json evidence/example-capability.json
printf '\n!evidence/\n' >> .gitignore
```

Then check no secret or raw PII reached the committed evidence:
```bash
grep -rn "sk-or-" evidence/ || echo "no api keys: ok"
grep -rln "OPENROUTER" evidence/ || echo "no key names: ok"
```

- [ ] **Step 7: Write `README.md`**

```markdown
# Capability Engine

An LLM discovers how to complete a goal in a legacy web application once. The run is
compiled into a typed, versioned **capability artifact**. That artifact then replays
deterministically — with no model in the decision loop — behind a policy gate, with
human escalation over the same live browser session.

> The model is a compiler, not an interpreter.

## Setup

Requires Node 22+.

```bash
npm install
npx playwright install chromium
cp .env.example .env     # set OPENROUTER_API_KEY
```

`OPENROUTER_API_KEY` is needed only for the discovery run. Replay, the operator flow
and the whole test suite run without any model access.

## Run it

Terminal 1 — the target application (an intentionally hostile stand-in for a core
banking back office: framesets, layout tables, no test IDs, a session timeout):

```bash
npm run target-app        # http://localhost:4000
```

Terminal 2 — discovery, then replay:

```bash
npm run discover -- \
  --goal "look up member 40021 and read their current savings balance" \
  --entry "http://localhost:4000/member/search" \
  --key "quest-core/member.savings_balance" \
  --params '{"memberId":"40021"}'

R="--capability quest-core/member.savings_balance@1.0.0 --tenant firstvalley-cu"
npm run replay -- $R --params '{"memberId":"40021"}'                  # success
npm run replay -- $R --params '{"memberId":"99999"}'                  # MEMBER_NOT_FOUND
npm run replay -- $R --params '{"memberId":"40021"}' --inject unknown-dialog   # blocked
npm run operator -- list
npm run operator -- resume <id> --note "cleared the notice"
npm run catalog
```

Set `HEADLESS=1` to run without a visible browser. The handoff demo is best watched
headful — the point is that the human drives the window the agent was using.

## Without live services

`npm test` exercises the whole system, including discovery, with a scripted model
stand-in. No API key required.

## Layout

| Path | What it is |
|---|---|
| `target-app/` | the hostile legacy surface |
| `src/surface/` | perception and actuation; the only Playwright import |
| `src/discover/` | the model-driven loop (compile time) |
| `src/compile/` | trace → capability |
| `src/replay/` | deterministic execution (run time) |
| `src/policy/` | allowlist, PASS/HOLD/DENY gate, redaction |
| `src/control/` | control lease and intervention queue |
| `evidence/` | a real discovery run, replays, and a blocked run |

See `REPORT.md` for the design and the reasoning.
```

- [ ] **Step 8: Write `REPORT.md` using the seven required headings**

Use exactly these headings, in this order: `## 1. Architecture`, `## 2. Artifact schema`,
`## 3. Determinism & error handling`, `## 4. Heterogeneity & multi-tenant`,
`## 5. Escalation & handoff`, `## 6. Safety`, `## 7. Cuts`.

Source the content from the spec at `docs/superpowers/specs/2026-09-17-computer-use-automation-design.md`,
sections 2, 3, 4, 5, 6, 7 and 13 respectively, condensed to 1–3 pages total. Carry over
verbatim: the compiler-not-interpreter thesis; the four-way result contract; the
declared-outcomes argument; the exactly-one resolver rule; the fencing-token lease;
the three-state gate with its stated limits in 7.4; and the refusal to add an LLM
fallback on replay. Drop spec section 14 (prior art) — it is internal context.

- [ ] **Step 9: Verify the demo path from a clean clone**

```bash
cd /tmp && rm -rf verify && git clone /d/interface-capability-engine verify && cd verify
npm install && npx playwright install chromium && npm test
```
Expected: all tests pass with no `.env` present.

- [ ] **Step 10: Commit**

```bash
git add README.md REPORT.md evidence store/bindings .gitignore
git commit -m "docs: README, design report, and evidence from a real discovery run and five replays"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 2 Architecture / module boundaries | 5, 10 |
| 3.1 Capability | 2, 7 |
| 3.2 Binding, override ladder, drift | 3, 9 |
| 3.3 Step + target descriptor | 2, 5, 7 |
| 3.4 Business outcomes | 2, 7, 9 |
| 4.1 Four-way result | 2, 9 |
| 4.2 Determinism | 5, 9, 10 |
| 4.3 Error taxonomy | 9 |
| 4.4 Drift | 3, 9 |
| 5 Surface abstraction | 5 |
| 6 Escalation, lease, handoff | 8, 9, 12 |
| 7.1–7.3 Gate, risk, redaction | 4 |
| 7.4 Limits | 12 (REPORT) |
| 8 Tech choices | 1, 12 (REPORT) |
| 9 State & persistence | 3, 6 |
| 10 Target app | 1 |
| 11 Demo path | 12 |
| 12 Catalog | 11 |
| 13 Cuts | 12 (REPORT) |

No spec requirement is unassigned.

**Placeholder scan:** no TBD/TODO; every code step carries the actual code; every test step carries the actual assertions.

**Type consistency checked:** `Capability`/`Binding`/`Step`/`Checkpoint`/`TargetDescriptor`/`ReplayResult` (Task 2) used unchanged in 3, 7, 9, 11. `A11yNode`/`Resolution`/`Observation`/`PolicyError` defined once in `src/surface/types.ts` and re-exported from `resolver.ts` and `web.ts`. `resolveDescriptor` returns `via: string` — consumed by `recordDrift(…, resolvedVia)` in Task 3 and by Task 9. `gate()` request/verdict shape identical in Tasks 4, 5. `Trace`/`TraceStep` defined in Task 6 and consumed only by Task 7 and the CLIs, matching the boundary test in Task 10. `ModelClient.name` used by `Trace.model` and `provenance.discoveredBy`.

**One deliberate ordering note:** `src/cli/discover.ts` (Task 6) imports `compile` from Task 7. No test imports the CLI, so Task 6 is green on its own; the CLI first runs in Task 12.
