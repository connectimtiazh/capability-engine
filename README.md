# Interface Capability Engine

A model is a compiler, not an interpreter: it looks at a hostile, unlabelled web application once,
during discovery, and produces a capability artifact — a file. Replaying that capability against a
live session never calls a model again; it walks the recorded steps deterministically, checking a
declared checkpoint after each one, and stops the moment it sees something it does not recognise
rather than improvise. This repo demonstrates that split against a deliberately hostile local
target application (nested layout tables, `<font>` tags, ASP-style control names, no `id` or
`data-testid` anywhere, and injectable interstitials). The target app also serves a frameset at `/`,
and frame traversal is implemented (`framePath` on every descriptor and DOM node, `src/surface/
web.ts`) — but every demo and test in this repo enters directly at `/member/search`, so that code
path is exercised by nothing here and should be read as implemented, not as demonstrated.

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
discovery ok  run=disc_<id>  steps=2
capability    quest-core/member.savings_balance@1.0.0
evidence      store\runs\disc_<id>
```

**2. Handoff demo.** `--wait` forces a visible (headful) browser regardless of `HEADLESS`, because
a person is meant to see and drive the parked window. This demo requires a `draft` capability — each
mutating step (fill, then click) is held for approval only while `approval.state` is `draft`. The
capability committed in this repo is already `approved` (it carries real replay history), so
reproducing this demo requires either running **1. Discover** again first (which writes a fresh
`draft` artifact) or editing `store/capabilities/quest-core/member.savings_balance/1.0.0.json` and
setting `"approval": { "state": "draft", ... }` back by hand before running the command below, then
restoring it (or re-running **3. Approve**) afterwards:

```
npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --wait
```

The run prints an intervention id and pauses. In another terminal:

```
npm run operator -- list
npm run operator -- resume <interventionId> --note "what you did"
```

The engine re-acquires the lease and re-resolves the parked step against the live page before doing
anything else — it does not trust that the human did what was asked — and continues. This repeats
once per mutating step. If the human used the pause to navigate the live browser somewhere this
step's own target cannot be found (see `REPORT.md` §3), the step blocks again with
`page_moved_during_handoff` instead of reporting whatever happens to be on that screen. See
`REPORT.md` §3 and §5 for the bug this closes and what running this exact demo produced.

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
{ "status": "success", "outputs": { "savingsBalance": 1284.55 }, "evidence": "store\\runs\\rep_<id>" }
```

Cross-member replay — same recorded capability, a different member, proving parameterisation:

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40023"}'
```
```
{ "status": "success", "outputs": { "savingsBalance": 312 }, "evidence": "store\\runs\\rep_<id>" }
```

An unknown member — a declared business outcome, not an error:

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"99999"}'
```
```
{ "status": "business_outcome", "code": "MEMBER_NOT_FOUND", "message": "No member exists with that number.", "evidence": "store\\runs\\rep_<id>" }
```

An injected, unrecognised dialog — exit code 2, blocked rather than guessed at:

```
HEADLESS=1 npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --inject unknown-dialog
```
```
{ "status": "blocked", "interventionId": "iv_6d1abe", "reason": "unrecognised_state_or_missing_control", "evidence": "store\\runs\\rep_<id>" }
```

**5. Catalog.** Lists every saved capability — draft and approved alike — as a callable tool
definition, with `unattended` distinguishing which ones may run without a human present, and can
invoke one by name:

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
| `src/catalog` | Renders every saved capability (draft and approved) as a callable tool definition |
| `src/cli` | `discover`, `replay`, `operator`, `catalog`, `approve` commands |
| `target-app` | The deliberately hostile local application used for every demo |
| `store/capabilities`, `store/bindings` | Committed artifacts: the real discovered capability and its tenant binding |
| `evidence/` | Committed run evidence from the live demo (redacted; see `REPORT.md` §6) |

See `REPORT.md` for the design write-up (architecture, artifact schema, determinism, multi-tenant,
escalation, safety, and cuts), and `evidence/` for the recorded runs referenced above.
