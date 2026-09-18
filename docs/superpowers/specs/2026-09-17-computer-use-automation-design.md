# Computer-Use Automation System — Design

**Date:** 2026-09-17
**Context:** interface.ai take-home. Backend integration layer that lets AI agents operate
legacy bank/credit-union back-office applications that expose no API.
**Time box:** 1–2 days. Thin-but-real across every core requirement; nothing left as a TODO.

---

## 1. Thesis

> **The model is a compiler, not an interpreter.**

Discovery is compile time. Replay is run time. An LLM runs once, against a live surface,
and emits a program. That program then executes forever without it.

This is not a cost argument. It is a correctness argument: a system whose behaviour is
re-derived by a model on every invocation cannot be audited, cannot be versioned, cannot
earn the right to run unattended, and cannot tell you why it did what it did last Tuesday.

Three consequences shape everything below:

1. The recorded artifact is a **contract**, not a macro. It declares what it needs, what it
   returns, and — critically — which non-happy endings are legitimate.
2. There is exactly **one door** to the outside world, and a policy gate stands in it.
3. **Unknown means stop.** A system that improvises around a screen it does not recognise
   is a system that is about to do something irreversible to a stranger's money.

---

## 2. Architecture

```
                    ┌──── COMPILE TIME (model present) ─────┐
 goal + entry ─────►│  discover/loop.ts   observe→decide→act │
                    │           │                            │
                    │           ▼  Trace                     │
                    │  compile/compile.ts                    │
                    └───────────┬────────────────────────────┘
                                ▼
                     Capability  (vendor-level, versioned JSON)
                     Binding     (tenant-level: URL, secret refs, overrides)
                                │
                    ┌───────────▼── RUN TIME (no model, ever) ──┐
  params ──────────►│  replay/execute.ts                        │────► Result (4-way)
                    │    ├ outcomes.ts   declared detectors      │
                    │    └ recovery.ts   recoverable conditions  │
                    └───────────┬───────────────────────────────┘
                                │
        ┌───────────────────────▼──────────────────────────┐
        │  policy/gate.ts        PASS | HOLD | DENY         │   one door
        └───────────────────────┬──────────────────────────┘
                                ▼
                surface/web.ts    ← the only module importing Playwright
                        │                    │
                        ▼                    ▼
              evidence/recorder.ts    control/lease.ts → interventions → operator CLI
```

### 2.1 Modules

```
src/
  surface/    types.ts  web.ts  resolver.ts      perception + actuation seam
  discover/   loop.ts  model.ts  prompt.ts       the only place a model is called
  compile/    compile.ts                          trace -> capability
  capability/ schema.ts  store.ts                 zod schemas, versioning, resolution
  replay/     execute.ts  outcomes.ts  recovery.ts
  policy/     gate.ts  allowlist.ts  redact.ts
  control/    lease.ts  interventions.ts
  evidence/   recorder.ts
  cli/        discover.ts  replay.ts  operator.ts  catalog.ts
target-app/   intentionally hostile legacy surface (Express + server-rendered HTML)
```

### 2.2 Boundary rules (each enforced, not merely stated)

| Rule | Why | Enforcement |
|---|---|---|
| Only `surface/web.ts` imports Playwright | A desktop surface becomes a new file, not a new system | dependency test |
| `replay/**` may not import `discover/**` or `model` | The compile-time / run-time wall, made physical | dependency test + replay tests inject a `ModelClient` that throws |
| Nothing acts except via `policy/gate.ts` | One gate, not one per path, so neither path can route around it | the gate lives *inside* the only module that can touch the screen |

### 2.3 Trade-offs taken

- **Single process, files on disk.** The brief states that building scaling infrastructure is
  not rewarded. A `Store` interface of six methods keeps the Postgres swap to one file.
- **No graph/agent framework.** See §8.
- **One surface implemented** (web). The desktop story is designed and argued, not built.

---

## 3. Artifact schema

Split in two. This split is the multi-tenant answer and the secret-handling answer at once.

### 3.1 Capability — belongs to the *vendor product*, not the institution

```jsonc
{
  "apiVersion": "capability/v1",
  "key": "quest-core/member.savings_balance",
  "version": "1.2.0",
  "title": "Look up a member's current savings balance",
  "description": "Returns the current share/savings balance for a member number.",

  "surface": { "kind": "web" },
  "vendor":  { "product": "quest-core", "observedVersion": "8.3" },

  "inputs": {
    "type": "object",
    "required": ["memberId"],
    "properties": {
      "memberId": { "type": "string", "pattern": "^[0-9]{5,10}$", "x-sensitivity": "pii" }
    }
  },
  "outputs": {
    "type": "object",
    "required": ["savingsBalance"],
    "properties": {
      "savingsBalance": { "type": "number" },
      "asOf": { "type": "string", "format": "date" }
    }
  },

  "steps": [ /* see 3.3 */ ],
  "successCondition": { "kind": "text-present", "framePath": ["main"], "text": "Share Balance" },
  "businessOutcomes": [ /* see 3.4 */ ],

  "risk": { "class": "read", "irreversible": false, "requiresApproval": false },

  "provenance": {
    "discoveredBy": "claude-opus-5",
    "discoveryRunId": "run_01J...",
    "recordedAt": "2026-09-17T...",
    "humanEdits": []
  },
  "approval": {
    "state": "draft",
    "replayStats": { "attempts": 0, "successes": 0, "lastFailure": null }
  }
}
```

### 3.2 Binding — belongs to *one tenant*

```jsonc
{
  "tenant": "firstvalley-cu",
  "capability": "quest-core/member.savings_balance@^1.2.0",
  "entryPoint": "https://corebank.firstvalley.internal/member/search",
  "credentials": { "ref": "env:FIRSTVALLEY_SVC" },
  "overrides": { "steps": { "s2": { "target": { "name": "Member #" } } } },
  "driftLog": [ { "step": "s2", "resolvedVia": "fallback[1]", "count": 14, "since": "..." } ]
}
```

Resolution order at replay: **binding override → vendor capability**. This mirrors the
version ladder already shipped in `Worker-Runtime-Kernel.get_skill_prompt()`
(`latest → 1.3.0 → 1.2.0 → ...`) — a resolution ladder is a pattern this codebase already trusts.

Three properties fall out:

- **One recording serves N tenants.** A matching tenant needs a Binding, not a re-recording.
- **Drift is a number, not a promise.** Every resolution records *which rung of the ladder*
  matched. A tenant consistently resolving via `fallback[1]` is drifting; the system can
  propose an override before anything breaks.
- **Secrets cannot enter the artifact by construction.** They live in the Binding, which is
  never the thing we version, share or review. Not "we remembered to strip them" — *can't*.

### 3.3 Step

```jsonc
{
  "id": "s3",
  "intent": "Submit the member number to the inquiry screen",
  "action": "click",
  "target": {
    "role": "button",
    "name": "Inquire",
    "framePath": ["main"],
    "anchor": { "kind": "table-cell", "rowHeader": "Member No.", "offset": { "col": 2 } },
    "fallbacks": [
      { "strategy": "name-attr", "value": "ctl00$btnInquire" },
      { "strategy": "nth-submit-in-form", "form": 0, "index": 0 }
    ]
  },
  "checkpoint": { "kind": "role-present", "role": "table", "nameContains": "Share" },
  "onError": [
    { "when": "dialog-present", "match": "Message of the Day", "do": "dismiss" },
    { "when": "timeout", "do": "retry", "max": 2, "backoffMs": 500 }
  ],
  "timeoutMs": 8000
}
```

**The artifact never stores a selector.** It stores an intent-level description of the
control — role, accessible name, the label nearest it, its frame path, its anchor cell in a
layout table. Replay resolves that description and must land on **exactly one** node.
Zero matches or two matches is a hard failure, never a guess.

This is also the desktop story: Win32 UIAutomation and macOS AX expose the same
role + accessible-name model. The descriptor survives; only the hands change.

### 3.4 Business outcomes — the load-bearing idea

```jsonc
[
  { "code": "MEMBER_NOT_FOUND",
    "detect": { "kind": "text-present", "framePath": ["main"], "text": "No record found" },
    "terminal": true,
    "message": "No member exists with that number." },
  { "code": "ACCOUNT_RESTRICTED",
    "detect": { "kind": "text-present", "text": "Access restricted" },
    "terminal": true }
]
```

"No such member" is the application working correctly and telling the truth. It is a
**declared return value with a typed code**, not an exception. The brief names conflating
these as the most common design mistake in this problem.

The declaration is load-bearing in both directions:

- A legitimate non-happy ending reaches the caller cleanly, with a code it can branch on.
- **Anything not on the list is not a business outcome, by definition.** The system cannot
  quietly reinterpret a breakage as "empty", because empty had to be declared in advance.

This is the structural form of a lesson already paid for: six production bugs in five days
that every one broke by *showing less data* rather than raising an error. The system must
know the difference between *there is nothing here* and *something broke*.

**And note where the model sits.** An earlier generation of this idea
(`Worker-Runtime-Kernel.observe_node`) sent each execution result *to an LLM* to be
interpreted into a normalised signal. That is exactly what must not happen at run time.
The correction is not to interpret better — it is to move the model to authoring time:
**the LLM authors the detector once, during discovery; it never runs it.**

---

## 4. Determinism & error handling

### 4.1 The result contract — four outcomes, not two

```ts
type ReplayResult =
  | { status: 'success';          outputs: T;      evidence: Ref }
  | { status: 'business_outcome'; code: string; message: string; evidence: Ref }
  | { status: 'blocked';          interventionId: string; reason: BlockReason; evidence: Ref }
  | { status: 'failed';           step: string; expected: string; observed: string;
                                  class: FailureClass; evidence: Ref }
```

Most systems have two and jam everything into them. `blocked` being distinct from `failed`
is what makes escalation a first-class path rather than an error handler.

### 4.2 How determinism is achieved

- **No model in the decision loop.** Enforced by dependency test and by injecting a throwing
  `ModelClient` into replay tests.
- **Exactly-one resolution.** A descriptor must match exactly one node. A system that picks the
  first of two matches is one that will eventually pick the wrong account. Resolving to zero or
  to many is never an action: on a `read` action it is a **hard failure** (nothing was going to
  change, so there is nothing for a human to decide); on a `mutate` action it is **blocked** and
  escalated, because a person choosing between two candidate controls is a legitimate
  intervention, whereas a machine guessing between them is not.
- **A checkpoint on every step, not one assertion at the end.** A click that silently landed on
  nothing fails *at that step*, with `{expected, observed}`, rather than producing a confusing
  failure four steps downstream.
- **No sleeps.** Waits are conditions with deadlines.
- **Inputs validated against the schema before the surface is touched.**

### 4.3 Runtime conditions, sorted in advance

| Class | Examples | Response |
|---|---|---|
| **Recoverable** | known interstitial ("Message of the Day"), transient slow load, session expiry | dismiss / bounded retry / re-auth then **re-assert the step checkpoint**; logged, not surfaced |
| **Business outcome** | record not found, account restricted, validation rejected | stop, return the declared code — a clean answer, not a crash |
| **Blocked** | unknown dialog, risky step pending approval, ambiguous resolution on a mutating action | park, raise an intervention, wait for a human |
| **Hard failure** | checkpoint failed after recovery, zero matches, allowlist violation | stop, return `failed` with step + expected + observed + evidence |

**Default on an unrecognised state is `blocked`, never "continue".** Recovery rungs are
declared on the step, so recovery itself is deterministic — the system is not deciding at run
time *how* to recover, it is executing a recovery that was decided at authoring time.

### 4.4 UI drift (secondary)

The environment is stable UIs with real runtime errors, so drift is the lesser problem. It is
handled by the resolver ladder plus `driftLog` (3.2): degrade to a fallback rung, keep
working, and make the degradation visible as a count so an override can be authored before
the primary rung disappears entirely.

---

## 5. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `Surface`:

```ts
interface Surface {
  observe(): Promise<Observation>                   // a11y tree + frame graph + screenshot
  resolve(t: TargetDescriptor): Promise<Resolution> // exactly-one | ambiguous | none
  act(a: Action, h: Handle): Promise<void>
  session(): SessionRef
}
```

Everything above this line — the artifact, the compiler, the replay engine, the policy gate —
is written in terms of roles, accessible names and text. None of it knows what a browser is.

- **Legacy web** (framesets, layout tables, no test IDs) is the implemented case. `framePath`
  and the table-cell anchor exist precisely for it.
- **Desktop** needs a `DesktopSurface` implementing the same four methods over UIAutomation
  or AX. The descriptor vocabulary already matches, because that vocabulary was taken from
  the accessibility layer rather than from the DOM. Designed, not built.

**Multi-tenant reuse.** Capability (vendor) / Binding (tenant), 3.2. Recorded once against the
vendor product; specialised per institution through overrides; drift detected by which rung
of the resolver ladder actually fires. No per-tenant re-recording, and no per-tenant code.

**Not built:** tenant isolation plumbing, a control plane, queues. The brief is explicit that
prematurely building scale infrastructure is not rewarded. The abstractions do not preclude it.

---

## 6. Escalation & handoff

### 6.1 Detecting stuck

Three triggers, all deterministic:

1. The policy gate returns **HOLD** (a risky/irreversible action, or an unapproved capability).
2. Replay hits an unrecognised state — an unknown dialog, or ambiguous resolution.
3. Discovery exhausts its step budget or loops without progress.

### 6.2 The control lease

```jsonc
{ "sessionId": "sess_...", "holder": "human:op-7", "token": 12, "acquiredAt": "..." }
```

A **fencing token**, not just a holder name. Every action carries the token it believes is
current; a stale token is rejected at the gate. Without fencing, "pause and resume" is a naming
convention and two writers can still both act. With it, single-writer is enforced.

### 6.3 The handoff, concretely

1. Run parks: `status = blocked`, lease released, intervention written with **which capability,
   which step, why it stopped, a screenshot, a DOM snapshot, and the redacted parameters**.
2. The browser is **headful and still open, on the same page, in the same session** — not a
   fresh one. The operator drives the real window.
3. `npm run operator -- resume <id> --note "cleared MOTD"` returns the lease, bumping the token.
4. **The engine re-asserts the parked step's checkpoint against the live page before
   continuing.** It does not assume the human did what was asked; it verifies. The human may
   have fixed it, or navigated somewhere else entirely.
5. What changed while the human held the lease is recorded (URL before/after, DOM digest,
   the operator's note) into the same timeline.

**Mocked deliberately:** the operator console is a CLI. The brief permits this explicitly. The
*mechanism* — pause, lease transfer, same live session, verified resume, recorded human
actions — is real. A screencast console over CDP is a UI on top of this seam, not a redesign.

---

## 7. Safety

### 7.1 A three-state gate

```
PASS  -> proceed
HOLD  -> park and escalate to a human   (not a failure — a decision a human owes us)
DENY  -> refuse outright
```

Ported from `Worker-Runtime-Kernel.guardrail_node`, **with one deliberate change**. That
version keyed on model confidence (`>= 0.7 PASS`, `>= 0.4 HOLD`). Keying a safety gate on a
self-reported confidence score contradicts the doctrine it was written under — guardrails are
never probabilistic. Here the inputs are facts:

| Input | Source |
|---|---|
| Is this origin/route on the allowlist? | config |
| Is this action `read` or `mutate`? | derived from the action verb |
| Is this capability `approved`? | artifact state |
| Does the caller hold the current lease token? | control lease |

Verb-derived risk classification follows the scope table already in the control plane
(`list_*`/`get_*`/`check_*` → read; `delete_*`/`update_*` → write): classification is derived,
not hand-labelled per step, so it cannot be forgotten on a new step.

### 7.2 Risky and irreversible actions

Mutating actions default to **HOLD** for a `draft` capability. An `approved` capability may
run them unattended. Approval is a human act recorded in the artifact, backed by
`replayStats` — autonomy is a permission a behaviour earns, and the only thing that can earn
it is production history.

### 7.3 Data handling

- **Sensitivity is declared in the input schema** (`x-sensitivity: pii | secret | safe`), not
  guessed by a regex over log lines. The schema is where sensitivity is known.
- The evidence recorder redacts by declared class before anything is written; flagged values
  are stored as salted hashes so a run can still be correlated.
- Screenshots mask the regions of fields bound to sensitive parameters.
- Credentials live in the Binding as refs (`env:` / `vault:`) and are resolved at use, never
  written to an artifact, a log, or a snapshot.

### 7.4 Limits (stated, because they will be probed)

- The allowlist governs *navigation and action class*, not semantics. It can stop the agent
  visiting an unapproved host; it cannot tell a $10 transfer from a $10,000 one. Amount-level
  policy belongs in the capability contract, and is not implemented.
- Screenshot masking is geometric. A sensitive value rendered somewhere unexpected is not
  caught. Declared-field masking is a floor, not a guarantee.
- A compromised Binding is a compromised tenant. Nothing here defends against that.

---

## 8. Technology choices

**TypeScript + Playwright.**

- One zod definition yields the runtime validator, the TS types, **and** the published JSON
  Schema the calling agent reads as a tool definition. The artifact schema is the most
  heavily weighted item in the rubric; this makes it typed end to end.
- Playwright's accessibility and frame APIs are first-class in TS.
- `npm i && npm start`. Reviewer friction is a real cost.

**No LangGraph, deliberately.** A graph framework orchestrates flows in which the model is
doing the deciding. This system's entire claim is that the model is absent from the production
path; interposing such a framework would sit between us and the property we are asserting.
Its checkpointing is checkpointing of *agent state*; what this system needs is a lease over a
live browser session, which is not a graph problem. The discovery loop is ~80 lines of `while`.

The concepts are still the right vocabulary, and REPORT.md names them against what was built
instead: *interrupt* → the control lease; *checkpointing / durable execution* → the persisted
run cursor and append-only timeline; *conditional edges* → the declared recovery rungs.

---

## 9. State & persistence

```
store/
  capabilities/<key>/<version>.json
  bindings/<tenant>/<key>.json
  runs/<runId>/run.json                  goal, status, cursor
  runs/<runId>/timeline.jsonl            append-only  <- this IS the /evidence deliverable
  runs/<runId>/evidence/s3-shot.png, s3-dom.html
  interventions/<id>.json
  control/<sessionId>.lease.json
```

- **JSONL, append-only.** A crash mid-run leaves a readable file, not a corrupt one; it is
  greppable with no tooling; and it is simultaneously the debug log, the audit trail and the
  evidence artifact — one thing doing three jobs rather than three that can disagree.
- **The run cursor is persisted after every step**, giving resumability without a framework.
  Required anyway: a run parked for a human may be parked for an hour.
- **One `Store` interface, six methods.** File backend ~80 lines; a Postgres swap is one file.

---

## 10. Target application

A locally built, intentionally hostile stand-in for a core-banking back office:
framesets, nested layout tables, `<font>` tags, ASP-style control names, no test IDs,
a 90-second session timeout, and a "Message of the Day" interstitial.

Chosen over a public demo site because it makes the required evidence *producible on demand*:
`MEMBER_NOT_FOUND`, a permission denial, a session expiry and an unexpected dialog can each
be triggered deliberately. A clean public site would make the locator-robustness argument
hypothetical and the error-path evidence simulated in our own layer rather than observed.

No real credentials, no real PII, no third-party terms at risk.

---

## 11. Demo path

```bash
npm run discover -- --goal "look up member 40021 and read their savings balance" \
                    --entry http://localhost:4000/member/search
# -> store/capabilities/quest-core/member.savings_balance/1.0.0.json (+ discovery evidence)

npm run replay   -- --capability quest-core/member.savings_balance@1.0.0 \
                    --tenant firstvalley-cu --params '{"memberId":"40021"}'
# -> { status: "success", outputs: { savingsBalance: 1284.55 } }

npm run replay   -- ... --params '{"memberId":"99999"}'
# -> { status: "business_outcome", code: "MEMBER_NOT_FOUND" }

npm run replay   -- ... --inject session-timeout
# -> recovers, re-asserts checkpoint, completes

npm run replay   -- ... --inject unknown-dialog
# -> { status: "blocked", interventionId: "iv_4" }   browser waits, headful
npm run operator -- list
npm run operator -- resume iv_4 --note "cleared vendor notice"
# -> lease returns, checkpoint re-asserted, run completes

npm run catalog                       # capabilities as callable tool definitions
npm run catalog -- invoke quest-core/member.savings_balance --args '{"memberId":"40021"}'
```

---

## 12. Stretch goal included: capability catalog

Because `inputs`/`outputs` are already zod → JSON Schema, exposing saved capabilities as a
catalog of callable tool definitions is roughly forty lines and one CLI command. It closes the
loop the brief describes — *this is what the agent-facing product actually invokes* — and turns
"an agent could call this" from a claim into a demonstrated call. Only `approved` capabilities
are listed for unattended invocation; `draft` ones are listed as attended-only.

---

## 13. Cuts

Deliberate, and stated in REPORT.md rather than left to be discovered.

| Cut | Why | What it would take |
|---|---|---|
| Operator console UI | Explicitly permitted; the mechanism is what is graded | CDP screencast page over the existing lease seam |
| Desktop surface | One `Surface` implementation is enough to prove the seam | `DesktopSurface` over UIAutomation/AX; the descriptors already fit |
| Multi-tenant plumbing | Brief says premature scale infrastructure is not rewarded | the Capability/Binding split is in; a second variant demo is ~2h |
| **LLM fallback on replay failure** | **Refused on principle, not cut for time** — it reintroduces the exact nondeterminism the system exists to eliminate | if ever built: bounded to one step, policy-checked, never unattended, recorded as evidence |
| Multi-run stability scoring | `replayStats` is the hook; the N-run harness is not built | a loop and a percentage |
| Auth flows | The target app stubs login | a `login` capability invoked as a precondition |

**Next, with more time, in order:** the second tenant variant with overrides (proves the
reuse claim empirically rather than structurally), then the screencast operator console,
then a desktop `Surface` against a small Win32 app.

---

## 14. Prior art in this codebase

This design is a port of positions already taken and shipped, not a fresh invention.
Worth naming, because the evolution is part of the argument.

| Here | Origin | Change |
|---|---|---|
| PASS/HOLD/DENY gate | `Worker-Runtime-Kernel.guardrail_node` | inputs swapped from model confidence to deterministic action class — the original contradicted its own doctrine |
| Declared outcome detectors | `Worker-Runtime-Kernel.observe_node` | the model authors the detector at compile time instead of interpreting results at run time |
| Gate between decide and act | WRK graph topology (`think -> guardrail -> execute`) | unchanged; the topological position *is* the argument |
| Binding / override ladder | WME `install_manifest`; `get_skill_prompt()` version ladder | unchanged in shape |
| Verb-derived risk class | Control-plane scope table (`list_*`->read, `delete_*`->write) | applied to UI actions rather than tool names |
| `allowed_capabilities` null-means-unrestricted | `dwos-ts/engine/permissions.ts` | unchanged |
| Park on "not allowed" rather than fail | `dwos-ts/engine/permissions.ts` comment | promoted from a comment to the `blocked` result status |
| Versioned behaviour, run/decision traceability | `CORE_DOCTRINES.md` D2/D3/D6/D10 | unchanged |
