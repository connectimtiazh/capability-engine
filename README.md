# Interface Capability Engine

A model is a compiler, not an interpreter: it looks at a hostile, unlabelled web application once,
during discovery, and produces a capability artifact — a file. Replaying that capability against a
live session never calls a model again; it walks the recorded steps deterministically, checking a
declared checkpoint after each one, and stops the moment it sees something it does not recognise
rather than improvise. This repo demonstrates that split against a deliberately hostile local
target application (nested layout tables, `<font>` tags, ASP-style control names, no `id` or
`data-testid` anywhere, and injectable interstitials). The target app also serves a frameset at `/`,
and frame traversal (`framePath` on every descriptor and DOM node, `src/surface/web.ts`) is now
genuinely exercised end to end by the test suite — entry navigation waits on the frameset's child
frames, a step resolves and acts inside a named frame, and outcome detection is scoped to the frame
it belongs to, including under a `?inject=slow-frame` race (`tests/surface.test.ts`, `tests/
replay.test.ts`). The capability shipped in this repo, `quest-core/member.savings_balance`, was
discovered directly at `/member/search`, though, so its steps carry an empty `framePath` and it is
not itself frame-scoped; running it against the frameset root (`--entry http://localhost:4000/`)
correctly blocks rather than guessing, because its targets don't exist at that framePath — see
"Break it yourself" below.

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
model — no network call, no API key. This currently passes **154 tests across 17 files**.

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
npm run approve -- quest-core/member.savings_balance@1.0.0 --business-risk read
```

```
approved quest-core/member.savings_balance@1.0.0 (by operator:local); business=read/human-confirmed; replayStats: {"attempts":...,"successes":...,"lastFailure":null}
```

`--business-risk` is how a human takes responsibility for what this capability actually does to the
bank's ledger (`risk.business`/`risk.businessSetBy` on the artifact) — separate from `approval.state`,
which only says its UI steps may run unattended. Omitting the flag leaves `risk.business` wherever
discovery left it (`unclassified`, or a model's own proposal, never authoritative on its own); an
`irreversible` capability's mutations stay held for a human on every step until this flag sets
`businessSetBy` to `human-confirmed` — see `REPORT.md` §2 and §6.

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

## Break it yourself

One command per runtime condition. Every row was actually run, against the target app started as
above, with the capability approved as in step 3. `HEADLESS=1` throughout; drop it to watch.

| Condition | Command | Result |
|---|---|---|
| Legitimate business outcome | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"99999"}'` | `{"status":"business_outcome","code":"MEMBER_NOT_FOUND","message":"No member exists with that number.","evidence":"store\\runs\\rep_5d53aec8"}` |
| Cross-member replay proving parameterisation | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40023"}'` | `{"status":"success","outputs":{"savingsBalance":312},"evidence":"store\\runs\\rep_30443678"}` — same recorded capability, a different member's own balance, not `40021`'s `1284.55` |
| A second declared outcome, distinct from "not found" | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40022"}'` | `{"status":"business_outcome","code":"ACCOUNT_RESTRICTED","message":"This member requires elevated entitlements.","evidence":"store\\runs\\rep_da973167"}` |
| Recovered session timeout | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --inject session-timeout` | `{"status":"success","outputs":{"savingsBalance":1284.55},"evidence":"store\\runs\\rep_ac7e9448"}` — `onError` signs back in and the run finishes; the timeline shows `step.recovered`, not `step.waited` |
| Blocked unknown dialog | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --inject unknown-dialog` | `{"status":"blocked","interventionId":"iv_22cfb7","reason":"unrecognised_state_or_missing_control","evidence":"store\\runs\\rep_0a25cbc3"}` — a dialog the capability didn't declare stops the run instead of being dismissed like the known "Message of the Day" |
| `step_timeout` under a tight budget † | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --inject slow-inquire` | `{"status":"failed","step":"s2","class":"step_timeout","observed":"action click did not complete within 1000ms: ...","evidence":"store\\runs\\rep_8de8dce8"}` |
| A run through the frameset at `/` ‡ | `npm run replay -- --capability quest-core/member.savings_balance@1.0.0 --params '{"memberId":"40021"}' --entry http://localhost:4000/` | `{"status":"blocked","interventionId":"iv_0ff9d7","reason":"unrecognised_state_or_missing_control","evidence":"store\\runs\\rep_085c847e"}` — entry navigation reaches the frameset and waits on its child frames, then correctly refuses: this capability's steps carry `framePath: []`, and the "Member No." control lives at `framePath: ["main"]` |

† `--inject slow-inquire` delays the `/member/inquire` POST by 3s; the shipped capability's own
`s2.timeoutMs` is `8000`, comfortably longer, so reproducing the timeout means temporarily
tightening it — the same "edit the artifact, run the demo, put it back" pattern step 2 above uses
for `approval.state`. Set `steps[1].timeoutMs` to `1000` and `steps[1].onError`'s `timeout` rung's
`max` to `1` in `store/capabilities/quest-core/member.savings_balance/1.0.0.json`, run the command,
then restore the two values.

‡ `--entry` overrides the tenant binding's own entry point for one run, without hand-editing
`store/bindings/`. This is the honest outcome for *this* capability: proof the frameset is actually
reached (see README intro), not proof this capability can drive it — a frame-scoped variant would
need `framePath: ["main"]` on every step and outcome, which is exactly what `tests/replay.test.ts`
("replay through the frameset at /") exercises end to end instead.

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
