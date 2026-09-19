# Design Report — Interface Capability Engine

## 1. Architecture

The model is a compiler, not an interpreter. Discovery — the phase where a model looks at a
screen and decides what to click — runs once, offline, and produces a file. Replay reads that
file and drives the browser with no model in the loop. This is a correctness argument before it
is a cost one: a system that re-derives its own behaviour on every invocation cannot be audited,
cannot be versioned, and cannot be trusted to run unattended, because nobody can say in advance
what it will do the next time it runs. A compiled artifact can be read, diffed, approved, and
re-run byte-for-byte identically.

The module map follows that split. `src/discover` runs the model loop against a live page and
produces a `Trace` (`src/discover/loop.ts`, `model.ts`, `prompt.ts`). `src/compile/compile.ts`
turns a trace into a `Capability` — the artifact — deriving checkpoints and parameterising
recorded literals. `src/capability` holds the schema (`schema.ts`, Zod-validated) and the
file-backed store (`store.ts`). `src/replay/execute.ts` is the runtime: it walks a capability's
steps against a live surface, with no knowledge of how that capability was produced. `src/surface`
is the one place that touches a real UI (`web.ts`, using Playwright, plus `resolver.ts` and
`types.ts`). `src/policy` holds the allowlist and the gate. `src/control` holds the lease and the
intervention queue. `src/evidence` records the timeline, screenshots, and DOM snapshots.
`src/catalog` turns an approved capability into a tool definition. `src/cli` wires all of the
above into commands.

Three rules keep discovery and replay from reconverging into one undifferentiated system:

1. Only `src/surface/web.ts` may import Playwright.
2. `src/replay` must never import `discover` or a model module, even transitively.
3. Only the compiler, discovery, and the CLI may reference the `Trace` type — replay operates on
   the compiled `Capability` and never sees the decision history that produced it.

`tests/boundaries.test.ts` enforces the first two structurally, by scanning import specifiers
across `src/`. The third is checked by the same file but by a text-pattern match on the word
`Trace` rather than a structural import check, so it is closer to a tripwire on convention than a
hard guarantee — it would not catch a renamed alias. All three tests currently pass.

The trade-off taken deliberately: one process, files on disk, no queue, no database. Scaling
infrastructure would be premature at this size, and `FileStore` is defined behind a narrow
interface (`saveCapability`, `loadCapability`, `resolveForTenant`, `recordDrift`,
`recordReplayAttempt`) so that swapping the backing store for a real database is a change to one
file, not a rewrite of discovery, replay, or the CLI.

## 2. Artifact schema

The real discovered artifact is
`store/capabilities/quest-core/member.savings_balance/1.0.0.json`. Trimmed:

```json
{
  "key": "quest-core/member.savings_balance",
  "version": "1.0.0",
  "inputs": {
    "required": ["memberId"],
    "properties": { "memberId": { "type": "string", "pattern": "^[0-9]+$", "x-sensitivity": "pii" } }
  },
  "outputs": {
    "required": ["savingsBalance"],
    "properties": { "savingsBalance": { "type": "number" } }
  },
  "steps": [
    { "id": "s1", "action": "fill",
      "target": { "role": "textbox", "name": "Member No.", "framePath": [] },
      "value": { "fromInput": "memberId" },
      "checkpoint": { "kind": "field-value-matches-input", "role": "textbox", "name": "Member No.", "input": "memberId" },
      "timeoutMs": 8000 },
    { "id": "s2", "action": "click",
      "target": { "role": "button", "name": "Inquire", "framePath": [] },
      "checkpoint": { "kind": "text-present", "text": "Share Balance" },
      "timeoutMs": 8000 },
    { "id": "s3", "action": "read",
      "target": { "anchor": { "kind": "table-cell", "rowHeader": "Share Balance", "offset": { "col": 1 } } },
      "extract": { "into": "savingsBalance", "as": "number" },
      "checkpoint": { "kind": "text-present", "text": "Share Balance" },
      "timeoutMs": 8000 }
  ],
  "businessOutcomes": [
    { "code": "MEMBER_NOT_FOUND", "detect": { "kind": "text-present", "text": "No record found" },
      "terminal": true, "when": { "route": "/member/inquire" } },
    { "code": "ACCOUNT_RESTRICTED", "detect": { "kind": "text-present", "text": "Access restricted" },
      "terminal": true, "when": { "route": "/member/inquire" } }
  ],
  "risk": { "interaction": "ui_mutation", "business": "read", "businessSetBy": "human-confirmed" },
  "approval": { "state": "approved", "approvedBy": "operator:local" }
}
```

Five choices shape this schema. First, a step's `target` is an intent-level descriptor — role,
accessible name, an optional table-cell anchor, and a fallback ladder — never a CSS selector or an
XPath. Replay must resolve a descriptor to exactly one live node or refuse; two candidates is
treated the same as zero (`src/surface/resolver.ts`). Second, every step carries its own
`checkpoint`, so a click that silently did nothing fails at that step, not four steps later where
the failure is harder to attribute. A fill's checkpoint (`field-value-matches-input`) goes further
than presence: it reads the control's live value back and compares it against the exact value this
invocation supplied, so a stale value left over from a previous run — a different member's number,
say — cannot be mistaken for evidence that this run's fill landed (`src/surface/web.ts`,
`checkpointHolds`; `tests/surface.test.ts`, "fails field-value-matches-input when a stale value is
already in the box"). A literal fill (no traceable input — nothing this invocation supplied to
compare against) keeps the weaker `field-has-value` check, which can only assert non-emptiness.
Third, `businessOutcomes` are declared as a list of (detector, code, message, route) tuples, and
`when.route` — checked against the frame it names, or the page when it names none — scopes each one
to the screen it was authored against: the same "No record found" text sitting on an unrelated page
must never be attributed to this operation's result (`src/replay/outcomes.ts`,
`detectBusinessOutcome`; `tests/outcomes.test.ts`, "does not fire when the matching text sits on a
different, unscoped page"). This makes "no such member" a typed, named return value rather than a
screen of text a caller has to parse, and it means anything the record run did not declare cannot
later be silently reinterpreted as an empty or successful result — an unrecognised screen stops the
run instead. Fourth, `risk` separates two facts that used to be one: `interaction` is `ui_mutation`
or `read`, a fact about the action verbs the recipe performs, derived mechanically from
`classifyAction`; `business` is a claim about what those verbs do to the bank's ledger — `read`,
`mutation`, or `irreversible` — and `businessSetBy` records who is answerable for that claim.
Discovery may have the model propose one (`model-proposed`, a hint with no authority); the policy
gate (`src/policy/gate.ts`) will not let an `irreversible` capability's mutations run unattended
until a human overrides it to `human-confirmed` via `npm run approve -- <ref> --business-risk
<read|mutation|irreversible>` — an approved-but-unconfirmed irreversible capability still holds for
a human on every mutating step (`tests/policy.test.ts`, "holds an approved capability marked
irreversible by a model proposal"; "passes an approved, irreversible capability once a human has
confirmed it"). Fifth, `approval` plus `replayStats` (`attempts`, `successes`, `lastFailure`) sit on
the artifact itself, because unattended execution is a permission a specific recorded behaviour
earns, and only a production history can earn it — a freshly discovered capability starts in
`draft` and cannot mutate anything until a human calls `npm run approve`.

The model authors the step intents and the extraction anchor, once, during discovery. Business-
outcome detectors are not among them, and are no longer a hardcoded compiler list either: each
detector is authored by a human, once per vendor application, in `vendors/<product>.outcomes.json`
(here, `vendors/quest-core.outcomes.json`) and loaded by `compile()` at compile time
(`loadOutcomeRegistry`, `src/compile/compile.ts`). A capability for "update mailing address" does
not inherit a detector meant for a balance inquiry just because both are QuestCore screens; a
vendor with no registry file compiles with zero outcomes rather than a guess. None of the three
run-time checks are evaluated by a model; `checkpointHolds`, `resolveDescriptor`, and
`detectBusinessOutcome` are all plain pattern matches over the current DOM snapshot.

## 3. Determinism & error handling

Replay returns exactly one of four statuses: `success`, `business_outcome`, `blocked`, `failed`
(`ReplayResultSchema` in `src/capability/schema.ts`). `blocked` and `failed` are kept distinct on
purpose: `blocked` means a human needs to act and the run is paused, recoverable, waiting;
`failed` means the run hit a condition nothing declared how to handle and stopped for good. Folding
these into one status would erase the difference between "come back and unstick me" and "this
capability needs to be re-recorded."

The error taxonomy is declared per step, in `onError`: a known interstitial (`dialog-present`,
matched by text and dismissed), a session expiry (`session-expired`, re-authenticated by following
the screen's own way back in), and a transient timeout (a bounded wait, not a fix). These are tried
in a fixed order — the generic timeout rung last, since it always runs and would otherwise mask a
more specific recovery from ever being tried (`src/replay/recovery.ts`). The timeline is honest about
which of these actually fired: `dialog-present` and `session-expired` log `step.recovered`, but the
bare `timeout` rung — which detects nothing and fixes nothing, it only waits — logs `step.waited`.
`evidence/rep_5ecd18a5` is a committed run showing the old bug (a false `step.recovered` for a
timeout wait that recovered nothing); `evidence/rep_d78bee66` is the same demo re-run under the fix.
A declared business outcome is
an answer, checked before every step and again after a failed checkpoint, so "no record found"
does not have to wait for the rest of the steps to fail first. Anything else — a resolver finding
zero or more than one match, an unrecognised screen — stops the run rather than guessing. This is
the rule the whole system is built around: unknown means stop. Improvising a next move on an
unfamiliar bank screen is the one thing this system must not do, because there is no way to tell in
advance whether the improvisation was safe.

Extraction returns a typed value looked up beside a declared label, not the raw screen text
(`src/replay/extract.ts`). `s3` in the artifact above reads whatever follows the "Share Balance"
row header and coerces it to a number, so `savingsBalance` is a number for every member the
capability is ever run against, not a screen of text a caller has to re-parse per invocation.

Checkpoint derivation is honest about what it can and cannot assert. A checkpoint asserts
structure — "Share Balance" is present on screen — never content, such as the balance itself. The
compiler's `distinctiveLine` function explicitly filters out any candidate line that carries a
supplied parameter or a token from a declared extraction, and if every line on the result screen
is volatile it refuses to compile a checkpoint at all rather than emit one that could only ever
replay correctly for the single record it was recorded against.

Per-step `timeoutMs` is enforced, not advisory. `execute.ts` computes a deadline once per step and
threads whatever remains of it into every surface call the step makes — resolve, act, checkpoint,
extract — as Playwright's own `timeout` option, never raced from outside
(`src/surface/web.ts`, `act`, `observeBudgeted`). A `timeout` recovery rung still runs, bounded by
its own `max`, but once the step's own clock runs out the run reports a distinct `step_timeout`
naming the step, rather than folding a slow page into the same failure class as a wrong one. The
entry navigation ahead of step one is budgeted the same way, against the first step's own
`timeoutMs`, so a slow target application produces a reportable `step_timeout` at `(entry)` instead
of hanging on Playwright's default (`tests/replay.test.ts`, "fails with step_timeout at (entry)
when the entry page overruns a tight first-step budget"). See the condition → test → evidence table
at the end of this section for the live demo.

### What the tests could not catch

The suite was green — 154 tests, all passing — when the first run with a human actually in the loop
returned a confident wrong answer: member 40021, who exists and has a balance, came back as
`MEMBER_NOT_FOUND`. `evidence/rep_51bad52a` is that run; `evidence/rep_c2ad2583` is the same demo
re-run under the fix, blocking honestly instead of guessing. No test had modelled a human navigating
the live page during a pause, because a suite exercises the inputs someone thought to write down,
and a live handoff is exactly the case where the interesting input is what happens when nobody
prescribed the next screen. The method that came out of it: every guarantee in this report now has
a test that was deliberately broken to prove it can fail, and every claim in this report points at a
committed run under `evidence/`.

Running the live handoff demo found a real bug in the replay loop itself, not in checkpoint
derivation. `evidence/rep_51bad52a/timeline.jsonl` shows it exactly: after `control.handback` for
the s2 (click "Inquire") intervention — recorded as `urlBefore=/member/search`,
`urlAfter=/member/inquire` — the timeline goes straight from `step.start s2` to
`replay.result business_outcome MEMBER_NOT_FOUND`. There is no `step.ok` and no action in between.
The old loop re-entered the step and called `detectBusinessOutcome` at the very top of the
iteration, before resolving the step's own target and before acting — so it read "No record found"
off whatever page the human had navigated to during the pause, for a member (40021) who is real and
has a balance. It never clicked. The fix (`src/replay/execute.ts`) tracks that the previous
iteration ended in a handback (`justResumed`); while that flag is set, outcome detection is skipped
and the step's own target must resolve on the live page before the run trusts anything on it again.
If it resolves, replay proceeds normally. If it does not, the run blocks with
`page_moved_during_handoff` instead of guessing — see §5 for the re-run of this exact demo under
the fix.

Preparing that same demo also turned up a second, unrelated defect, since fixed: the `field-has-value`
checkpoint on step s1 originally asserted only that a control with the given role and name existed
on screen — a check that could never fail, since the field is on screen whether or not anything was
ever typed into it. It was not the cause of the `MEMBER_NOT_FOUND` above (that was the loop bug
described above); it is a separate gap in checkpoint derivation, found in the course of the same
demo. A fill traced back to a declared input now compiles to `field-value-matches-input`, which
reads the control's live value and compares it against the exact value this invocation supplied —
not merely that it holds something, not merely that it is non-empty — and reports
`checkpoint_failed` with a redacted diagnostic (`field ... holds [redacted], expected [redacted]`
for a `pii`-declared input; `src/policy/redact.ts`, `redactValue`) if it does not match
(`src/surface/web.ts`, `checkpointHolds`). `tests/surface.test.ts`, "fails field-value-matches-input
when a stale value is already in the box," is the unit proof: a field cleared and refilled with a
different value, or cleared after its own checkpoint passed but before the next step reads it, is
exactly the case this closes. A fill with nothing to trace back to — a literal, not lifted from a
parameter — keeps the weaker `field-has-value` check, since there is no per-invocation value to
compare it against; that narrower gap is real and remains.

### Terrain cases: condition → test → evidence

| Condition | Test | Evidence |
|---|---|---|
| Stale value already in the field | `tests/surface.test.ts` — "fails field-value-matches-input when a stale value is already in the box" | unit test; the checkpoint predicate is pure, no live run needed |
| Outcome text on the wrong page | `tests/outcomes.test.ts` — "does not fire when the matching text sits on a different, unscoped page" | unit test |
| Page too slow for its budget | `tests/replay.test.ts` — "fails with step_timeout, naming the step, when a mid-flow step exceeds its budget" | `evidence/rep_8de8dce8` — live demo, `s2.timeoutMs` tightened to 1000ms against `--inject slow-inquire` |
| Human moves the page mid-handoff | `tests/handoff.test.ts` — "does not read a business outcome off a page a human moved during a handback (C1)" | `evidence/rep_51bad52a` (before) → `evidence/rep_c2ad2583` (after) |
| Frameset entry with a slow child | `tests/surface.test.ts` — "a one-shot resolve immediately after open() finds the textbox even when the \"main\" frame is slow to load"; `tests/replay.test.ts` — "survives a \"main\" frame slower than any incidental retry cushion" | unit/integration tests against `?inject=slow-frame`; no committed live-demo run — see §7 |

## 4. Heterogeneity & multi-tenant

The `Surface` interface (`src/surface/types.ts`) is the seam between a capability and the
concrete application it drives. `WebSurface` is the only implementation built, but the descriptor
vocabulary a target carries — role plus accessible name, not a CSS selector — was chosen because it
is also what Win32 UIAutomation and macOS Accessibility expose for native and legacy desktop
controls. An artifact recorded against a web page and one recorded against a native dialog would
describe their targets the same way; only the code that resolves a descriptor to a live control and
the code that acts on it change. A capability survives a change of surface; only the hands change.

Two artifacts separate what is shared across customers of the same vendor product from what is
specific to one deployment. `Capability` is vendor-level: recorded once against one instance of
Quest Core, versioned, and reused. `Binding` is tenant-level: an entry point URL, a reference to
where credentials live (`env:` or `vault:`, never a literal — enforced by the schema), and optional
per-step overrides that are deep-merged over the base capability at resolve time
(`FileStore.resolveForTenant`). A tenant whose screen differs slightly authors an override for the
one step that differs; the rest of the capability is untouched.

Drift is measured, not asserted. Every successful resolution records which rung of the fallback
ladder actually fired — `primary`, `labelText`, or `fallback[n]` — and when that rung is not
`primary`, `FileStore.recordDrift` logs it against the tenant's binding with a count and a
timestamp. A tenant that keeps resolving through a fallback is visibly drifting away from the base
recording, and an override can be authored before the ladder runs out and the step starts failing
outright, rather than after.

What is not built: tenant isolation plumbing (every tenant's data lives in the same file tree
today), a control plane for managing many tenants at once, and any queueing between them. One
`FileStore` process serves every tenant sequentially.

## 5. Escalation & handoff

Three conditions stop a run deterministically and hand it to a human rather than let it guess.
A resolver finding more than one match for a mutating step's target is not a decision the run can
make on its own — an ambiguous read fails outright, but an ambiguous mutate raises an intervention,
because a person choosing between two candidates is a legitimate thing to ask for. A resolver
finding no match at all — an unrecognised screen — always raises an intervention regardless of the
capability's declared risk; an unfamiliar state is exactly where automation should stop rather than
improvise. And a
mutating action on a still-`draft` capability is held by the policy gate until a human grants
one-shot approval for that specific step.

Underneath all three is a control lease with a fencing token (`src/control/lease.ts`). The lease
cuts both ways: the operator handle refuses to act while the agent holds it
(`operator_acted_while_agent_holds_lease`), and the replay engine checks that it still holds the
lease before acting and stops if it does not (`lease_lost`) — so at most one party can act on the
live session at any moment. The cycle: evidence (a screenshot and a DOM snapshot) is captured while
the agent still holds the lease; the lease is released to the human; an intervention is raised with
the capability, the step, the reason, and pointers to that evidence; the engine polls for
resolution; the human drives the same live browser window the agent was just driving; on
resolution the engine re-acquires the lease with a fresh token and retries the parked step from the
top, not from wherever the human left off.

That retry is the verification. The engine does not trust that the human did what was asked; it
re-observes the page and re-resolves the target before doing anything else — including before
reading a business outcome off the screen, which was not true until the fix in §3 closed it. If the
human left the page in a state the target cannot be found on, the step blocks again, now with
`page_moved_during_handoff` rather than silently trusting whatever is on screen. The operator
console here is a CLI (`npm run operator -- list | show | resume`) by choice — a graphical console would sit on the same
seam — but the handoff mechanics behind it (lease, fencing token, intervention record, retry
from a live re-observation) are real, not simulated, and are what would sit behind a graphical
console if one were built.

The live handoff demo was re-run against the fixed code, reproducing the same shape of interaction
as `evidence/rep_51bad52a`: both interventions raised correctly, s1 approved and completed cleanly,
and then, for s2, the human drove the live session to a page with no "Inquire" control on it at all
before handing back — a stand-in for the same drift `rep_51bad52a`'s `control.handback` shows
(`urlBefore=/member/search`, `urlAfter=/member/inquire`). Where the old
code went straight to `MEMBER_NOT_FOUND` without ever re-clicking, the fixed run
(`evidence/rep_c2ad2583/timeline.jsonl`) re-resolves s2's own target on the page the human left,
finds nothing, raises a third intervention with reason `page_moved_during_handoff`, and — nobody
resolving it — ends `status: "blocked"` with that reason. This is the correct ending: the mechanics
(lease, fencing token, retry-from-a-live-re-observation) all worked, and the run said "I don't know
where I am" instead of guessing. `evidence/rep_51bad52a` is kept as the committed record of the bug;
`evidence/rep_c2ad2583` is the same demo re-run under the fix. The separate `field-value-matches-input`
fix described in §3 is proven by `tests/surface.test.ts` rather than by a second live demo run — see
the condition → test → evidence table at the end of §3.

## 6. Safety

Every action funnels through one gate (`src/policy/gate.ts`), called from inside
`WebSurface.check`, the only method that touches the live page. Its inputs are deterministic:
whether the target URL's origin and path prefix are on the allowlist, whether the action's class
(`read` or `mutate`, derived from the verb, not hand-labelled per step) requires approval, whether
the capability's `approval.state` is `approved`, whether the caller currently holds the lease, and —
for a mutation on a capability whose `risk.business` is `irreversible` — whether `risk.businessSetBy`
is `human-confirmed`. `approval.state === 'approved'` lifts the draft hold for `read`, `mutation`, and
`unclassified` business risk; it does not by itself vouch for an irreversible consequence, which a
model proposing it (`businessSetBy: 'model-proposed'`) or the compiler defaulting it
(`'default'`) does not get to make good on — only `npm run approve -- <ref> --business-risk
irreversible` does (`tests/policy.test.ts`, "holds an approved capability marked irreversible by a
model proposal" / "passes an approved, irreversible capability once a human has confirmed it").
Model confidence is not an input to this gate, deliberately — a safety check keyed on a
self-reported score from the same model whose actions it is meant to constrain is not a safety
check. Because the gate lives inside the one module that can reach Playwright, neither discovery
nor replay has a path around it; there is no second door.

Sensitivity is declared, not inferred. A capability's input schema marks a field `x-sensitivity:
pii` or `secret`, and that declaration — never a regex over the value — is what
`src/policy/redact.ts` and the recorder use to decide what to scrub. A declared value is hashed
(`pii`) or replaced outright (`secret`) before it reaches the timeline (`Recorder.event`), a DOM
snapshot (`Recorder.dom`), or a screenshot mask (`Recorder.shot`, which masks the matching input
elements and the literal text). This redaction is precise about what it covers and what it does
not: it scrubs declared *input* values. A discovery trace deliberately retains observed screen
content — what the model actually saw — because that content is the evidence of what informed its
decisions, and the target application's data is synthetic. In the committed discovery evidence
(`evidence/disc_40ec511e/trace.json`), the member number typed in as input does not appear anywhere
in the file, but the balance the screen displayed back, `1284.55`, appears five times, because it
was read off the page rather than declared as an input.

**Limits.** The allowlist governs navigation and which verbs may run, not what those verbs mean:
it cannot tell a ten-dollar transfer from a ten-thousand-dollar one, and amount-level policy is not
built — it belongs in a capability's own contract if one is ever recorded for a mutating financial
action. Screenshot masking is geometric, and text-matching does not reach inside a frame; a
sensitive value rendered somewhere the recorder did not anticipate, or inside a frameset, can
escape the mask. The set of values treated as "varies per invocation" during compilation covers
only what was declared as an input or an extraction; an undeclared value that happens to change
every run — a rendered timestamp nobody wired to an output — could still be chosen as a checkpoint
anchor, and the only fix is to declare it as an extraction so the compiler knows to avoid it. A
checkpoint on a fill traced back to a declared input now asserts it holds exactly that value
(`field-value-matches-input`, §3); a literal fill — nothing to trace back to — still only gets a
non-emptiness check, since there is no per-invocation value to compare it against. The control
lease assumes exactly one writer, the replay engine; a second lease writer would reopen the
compare-and-swap race the fencing token exists to close, and closing it again would need a lock
file. And a compromised `Binding` is a compromised tenant: nothing here defends against a binding
file itself being tampered with.

Four narrower gaps, specific to this wave's own work, are worth naming plainly rather than folding
into the paragraph above. `open()` waits for every child frame the frameset happens to have, not
only the ones a given capability's steps actually touch (`src/surface/web.ts`, F52) — harmless here,
where the frameset has exactly two frames and both load fast, but a frameset with a child no
capability ever reads would still be waited on. The vendor outcome registry's route/frame entries
are non-overlapping in `vendors/quest-core.outcomes.json` because this app's own routes happen not
to collide, not because `loadOutcomeRegistry` or `detectBusinessOutcome` enforce it — nothing
rejects two entries that would both match the same screen, and the first in file order would win
silently. The replay-level "survives a main frame slower than any incidental retry cushion" test
does not actually discriminate a fixed `open()` from a broken one, by its own comment
(`tests/replay.test.ts`, F52): `observe()`'s own frame evaluation happens to absorb the same delay
by a different path, so it is kept as an end-to-end regression guard, not as the proof — the test
that actually distinguishes them is in `tests/surface.test.ts`. And the committed handoff evidence
(`evidence/rep_51bad52a`, `evidence/rep_c2ad2583`) is a script driving both sides of the pause, not
an independent person; it demonstrates the mechanics (lease, fencing token, retry-from-a-live-
re-observation) faithfully, but it is not a substitute for an actual second operator.

## 7. Cuts

Left out deliberately, in order of how much would be involved to add: a graphical operator
console, since the mechanism it would sit on (lease, intervention
queue, live browser handle) already exists; a CDP screencast of the same page the operator handle
already drives is the natural next layer. A desktop `Surface` implementation — designed against the
same descriptor vocabulary as the web one, but one implementation was enough to prove the seam
holds. Multi-tenant plumbing beyond `Binding` and `driftLog` — isolation, a control plane, queues
between tenants. Multi-run stability scoring — `replayStats` on the artifact is the hook a scoring
system would read, but the harness that would run a capability N times and score its stability is
not built. Auth flows — the target application stubs login rather than requiring it. Per-discovery-
trace business-outcome proposal — §2 describes the outcome registry (`vendors/<product>.outcomes
.json`) as human-authored, once per vendor, and loaded at compile time; that is a real improvement
over the old hardcoded compiler list, but it is still authored ahead of any particular discovery run,
not derived from one. Having the model (or a human, reviewing a specific trace) propose additional
detectors — or flag that a vendor has none yet — specific to what that discovery run actually saw is
not built, and a capability discovered against a vendor with a stale or incomplete registry file
compiles silently with whatever that file happens to declare, right or wrong.

One cut is refused on principle rather than for time: an LLM fallback for when replay fails. It
would reintroduce exactly the nondeterminism this system exists to remove — the entire argument in
§1 is that a capability's behaviour should not be re-derived at run time. If it were ever built, it
would have to be bounded to a single step, checked against the same policy gate as every other
action, never run unattended, and recorded as evidence rather than silently substituted for the
recorded step.

What would come next, in order: a second tenant variant with real step overrides, to demonstrate
the reuse claim in §4 empirically rather than only structurally; then the screencast operator
console; then a desktop `Surface`.
