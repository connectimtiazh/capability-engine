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

The trade-off taken deliberately: one process, files on disk, no queue, no database. The
assignment does not reward scaling infrastructure, and `FileStore` is defined behind a narrow
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
    "properties": { "memberId": { "type": "string", "pattern": "^[0-9]{5}$", "x-sensitivity": "pii" } }
  },
  "outputs": {
    "required": ["savingsBalance"],
    "properties": { "savingsBalance": { "type": "number" } }
  },
  "steps": [
    { "id": "s1", "action": "fill",
      "target": { "role": "textbox", "name": "Member No." },
      "checkpoint": { "kind": "field-has-value", "role": "textbox", "name": "Member No." } },
    { "id": "s2", "action": "click",
      "target": { "role": "button", "name": "Inquire" },
      "checkpoint": { "kind": "text-present", "text": "Share Balance" } },
    { "id": "s3", "action": "read",
      "target": { "anchor": { "kind": "table-cell", "rowHeader": "Share Balance", "offset": { "col": 1 } } },
      "extract": { "into": "savingsBalance", "as": "number" },
      "checkpoint": { "kind": "text-present", "text": "Share Balance" } }
  ],
  "businessOutcomes": [
    { "code": "MEMBER_NOT_FOUND", "detect": { "kind": "text-present", "text": "No record found" }, "terminal": true },
    { "code": "ACCOUNT_RESTRICTED", "detect": { "kind": "text-present", "text": "Access restricted" }, "terminal": true }
  ],
  "approval": { "state": "approved", "approvedBy": "operator:local" }
}
```

Four choices shape this schema. First, a step's `target` is an intent-level descriptor — role,
accessible name, an optional table-cell anchor, and a fallback ladder — never a CSS selector or an
XPath. Replay must resolve a descriptor to exactly one live node or refuse; two candidates is
treated the same as zero (`src/surface/resolver.ts`). Second, every step carries its own
`checkpoint`, so a click that silently did nothing fails at that step, not four steps later where
the failure is harder to attribute. Third, `businessOutcomes` are declared at record time as a
list of (detector, code, message) triples. This makes "no such member" a typed, named return value
rather than a screen of text a caller has to parse, and it means anything the record run did not
declare cannot later be silently reinterpreted as an empty or successful result — an unrecognised
screen stops the run instead. Fourth, `approval` plus `replayStats` (`attempts`, `successes`,
`lastFailure`) sit on the artifact itself, because unattended execution is a permission a specific
recorded behaviour earns, and only a production history can earn it — a freshly discovered
capability starts in `draft` and cannot mutate anything until a human calls `npm run approve`.

The model authors detectors, extraction anchors, and step intents once, at compile time
(`src/compile/compile.ts`). None of them is evaluated by a model at run time; `checkpointHolds`,
`resolveDescriptor`, and `detectBusinessOutcome` are all plain pattern matches over the current DOM
snapshot.

## 3. Determinism & error handling

Replay returns exactly one of four statuses: `success`, `business_outcome`, `blocked`, `failed`
(`ReplayResultSchema` in `src/capability/schema.ts`). `blocked` and `failed` are kept distinct on
purpose: `blocked` means a human needs to act and the run is paused, recoverable, waiting;
`failed` means the run hit a condition nothing declared how to handle and stopped for good. Folding
these into one status would erase the difference between "come back and unstick me" and "this
capability needs to be re-recorded."

The error taxonomy is declared per step, in `onError`: a known interstitial (`dialog-present`,
matched by text and dismissed), a session expiry (`session-expired`, re-authenticated by following
the screen's own way back in), and a transient timeout (bounded retries with backoff). These are
tried in a fixed order — the generic timeout rung last, since it succeeds unconditionally and would
otherwise mask a more specific recovery (`src/replay/recovery.ts`). A declared business outcome is
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

That structure-only guarantee has a real edge, found by running the live handoff demo. The
`field-has-value` checkpoint originally asserted only that a control with the given role and name
existed on screen — a check that could never fail, since the field is on screen whether or not
anything was typed into it. During a `--wait` run, a real-clock pause between a blocked step and a
human's resolution left the member-number input empty by the time the next step ran; the
checkpoint reported "present" regardless, the next step submitted the empty field, and the run
returned `MEMBER_NOT_FOUND` for a member who is real and has a balance — a confident wrong answer
delivered through the one channel the system exists to make trustworthy. The checkpoint now reads
the control's live value (`src/surface/web.ts`, `checkpointHolds`), so the same condition surfaces
as `checkpoint_failed` at the step, with the expected and observed values in the result, rather
than continuing. A stronger variant would compare the field's live value against the parameter
that was supposed to be in it, rather than only checking non-emptiness; that is not built, and the
gap it leaves is real — a field cleared and then re-filled with something else, or cleared after
its own checkpoint passed but before the next step reads it, would not be caught by a non-emptiness
check alone. This was reproduced again, independently, while preparing this report.

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
finding no match at all — an unrecognised screen — always raises an intervention regardless of risk
class; an unfamiliar state is exactly where automation should stop rather than improvise. And a
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
re-observes the page and re-resolves the target, and if the human left the page in a state the
target cannot be found on, the step blocks again with the same reason. The operator console here is
a CLI (`npm run operator -- list | show | resume`) by choice — the assignment permits mocking the
console — but the handoff mechanics behind it (lease, fencing token, intervention record, retry
from a live re-observation) are real, not simulated, and are what would sit behind a graphical
console if one were built.

The live `--wait` demo exercised this mechanism honestly and did not end in success. Both
interventions were raised correctly, resolved with a one-shot approval each, and control was handed
back correctly both times; the run instead hit the environment-dependent condition described in
§3 — a real-clock pause across a headful window emptied the filled input — and returned
`MEMBER_NOT_FOUND`. The mechanics worked. The run's answer was wrong until the checkpoint fix
above, and even after the fix the same class of gap can still surface as a `checkpoint_failed`
rather than a silent success, which is the correct failure mode for a system built to prefer an
honest stop over a confident guess.

## 6. Safety

Every action funnels through one gate (`src/policy/gate.ts`), called from inside
`WebSurface.check`, the only method that touches the live page. Its inputs are deterministic:
whether the target URL's origin and path prefix are on the allowlist, whether the action's class
(`read` or `mutate`, derived from the verb, not hand-labelled per step) requires approval, whether
the capability's `approval.state` is `approved`, and whether the caller currently holds the lease.
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
checkpoint can assert that a field is non-empty; it cannot assert that it holds the correct value,
which is the gap discussed in §3. The control lease assumes exactly one writer, the replay engine;
a second lease writer would reopen the compare-and-swap race the fencing token exists to close, and
closing it again would need a lock file. An input's `pattern` is inferred from a single recorded
example (`^[0-9]{5}$` from one five-digit member number), so it over-fits and would reject a valid
value of a different length. And a compromised `Binding` is a compromised tenant: nothing here
defends against a binding file itself being tampered with.

## 7. Cuts

Left out deliberately, in order of how much would be involved to add: a graphical operator
console — permitted by the assignment, and the mechanism it would sit on (lease, intervention
queue, live browser handle) already exists; a CDP screencast of the same page the operator handle
already drives is the natural next layer. A desktop `Surface` implementation — designed against the
same descriptor vocabulary as the web one, but one implementation was enough to prove the seam
holds. Multi-tenant plumbing beyond `Binding` and `driftLog` — isolation, a control plane, queues
between tenants. Multi-run stability scoring — `replayStats` on the artifact is the hook a scoring
system would read, but the harness that would run a capability N times and score its stability is
not built. Auth flows — the target application stubs login rather than requiring it.

One cut is refused on principle rather than for time: an LLM fallback for when replay fails. It
would reintroduce exactly the nondeterminism this system exists to remove — the entire argument in
§1 is that a capability's behaviour should not be re-derived at run time. If it were ever built, it
would have to be bounded to a single step, checked against the same policy gate as every other
action, never run unattended, and recorded as evidence rather than silently substituted for the
recorded step.

What would come next, in order: a second tenant variant with real step overrides, to demonstrate
the reuse claim in §4 empirically rather than only structurally; then the screencast operator
console; then a desktop `Surface`.
