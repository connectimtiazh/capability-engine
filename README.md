# Interface Capability Engine

A model is a compiler, not an interpreter: it looks at a hostile, unlabelled web application once,
during discovery, and produces a capability artifact — a file. Replaying that capability against a
live session never calls a model again; it walks the recorded steps deterministically, checking a
declared checkpoint after each one, and stops the moment it sees something it does not recognise
rather than improvise. This repo demonstrates that split against a deliberately hostile local
target application (a frameset, nested layout tables, `<font>` tags, ASP-style control names, no
`id` or `data-testid` anywhere, and injectable interstitials).

## Setup

- Node 22
- `npm install`
- `npx playwright install chromium`
- `cp .env.example .env` — `OPENROUTER_API_KEY` is needed **only** for discovery (`npm run
  discover`). Replay, the catalog, the operator CLI, and the full test suite never call a model
  and run without it.

## Run without live services

```
npm test
```

Exercises the whole system, including the discovery loop, against a scripted stand-in for the
model — no network call, no API key. This currently passes **118 tests across 16 files**.

`npm run typecheck` runs clean with no output.

## Demo path

Start the target application first (leave it running in its own terminal):

```
npm run target-app
```

Then, in order:

**1. Discover.** Watches the target app and produces a draft capability.

```
HEADLESS=1 npm run discover -- --goal "look up member 40021 and read their current savings balance" \
  --entry "http://localhost:4000/member/search" \
  --key "quest-core/member.savings_balance" \
  --params '{"memberId":"40021"}'
```

```
discovery ok  run=disc_349ee480  steps=2
capability    quest-core/member.savings_balance@1.0.0
evidence      store\runs\disc_349ee480
```

**2. Handoff demo.** `--wait` forces a visible (headful) browser regardless of `HEADLESS`, because
a person is meant to see and drive the parked window. Against a freshly discovered `draft`
capability, each mutating step (fill, then click) is held for approval:

```
npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --wait
```

The run prints an intervention id and pauses. In another terminal:

```
npm run operator -- list
npm run operator -- resume <interventionId> --note "what you did"
```

The engine re-acquires the lease, re-resolves the parked step against the live page — it does not
trust that the human did what was asked — and continues. This repeats once per mutating step. Note
that the handoff mechanics (lease, fencing token, retry-as-verification) can be exercised this way,
but a real-clock pause across a headful window is an environment-dependent condition: see
`REPORT.md` §3 and §5 for what was found by running this exact demo and how the system now
surfaces it rather than returning a silent wrong answer.

**3. Approve.** Promotes the capability so its mutating steps can run unattended.

```
npm run approve -- quest-core/member.savings_balance@1.0.0 --by "operator:local"
```

```
approved quest-core/member.savings_balance@1.0.0 (by operator:local); replayStats: {"attempts":...,"successes":...,"lastFailure":null}
```

**4. Replay demos**, all unattended (`HEADLESS=1`):

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}'
```
```
{ "status": "success", "outputs": { "savingsBalance": 1284.55 }, "evidence": "store\\runs\\rep_68527e8a" }
```

Cross-member replay — same recorded capability, a different member, proving parameterisation:

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40023"}'
```
```
{ "status": "success", "outputs": { "savingsBalance": 312 }, "evidence": "store\\runs\\rep_306638f8" }
```

An unknown member — a declared business outcome, not an error:

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"99999"}'
```
```
{ "status": "business_outcome", "code": "MEMBER_NOT_FOUND", "message": "No member exists with that number.", "evidence": "store\\runs\\rep_47af3c52" }
```

An injected, unrecognised dialog — exit code 2, blocked rather than guessed at:

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --inject unknown-dialog
```
```
{ "status": "blocked", "interventionId": "iv_6d1abe", "reason": "unrecognised_state_or_missing_control", "evidence": "store\\runs\\rep_f0e17093" }
```

**5. Catalog.** Lists approved capabilities as callable tool definitions and can invoke one by name:

```
npm run catalog
npm run catalog -- invoke quest_core__member_savings_balance --args '{"memberId":"40021"}'
```

Stop the target app (`Ctrl-C` in its terminal, or kill the `tsx target-app/server.ts` process) once
you are done.

## What lives where

| Path | Contents |
|---|---|
| `src/discover` | The model loop that produces a `Trace` from a live page |
| `src/compile` | Turns a `Trace` into a versioned `Capability` artifact |
| `src/capability` | Capability/Binding schema (Zod) and the file-backed store |
| `src/replay` | The model-free runtime that executes a capability |
| `src/surface` | The only place that touches a real UI (Playwright) |
| `src/policy` | Allowlist and the three-state safety gate |
| `src/control` | Control lease (fencing token) and the intervention queue |
| `src/evidence` | Timeline, screenshot, and DOM snapshot recording, with redaction |
| `src/catalog` | Renders approved capabilities as callable tool definitions |
| `src/cli` | `discover`, `replay`, `operator`, `catalog`, `approve` commands |
| `target-app` | The deliberately hostile local application used for every demo |
| `store/capabilities`, `store/bindings` | Committed artifacts: the real discovered capability and its tenant binding |
| `evidence/` | Committed run evidence from the live demo (redacted; see `REPORT.md` §6) |

See `REPORT.md` for the design write-up (architecture, artifact schema, determinism, multi-tenant,
escalation, safety, and cuts), and `evidence/` for the recorded runs referenced above.
