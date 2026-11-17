# Flow optimisation design

Architecture reference. To shorten a flow or run the example, start with
[the task guide](FLOW-OPTIMISATION.md).

The authoring skill, offline helpers and synthetic native flows described here
are implemented. See [the executable guide](FLOW-OPTIMISATION.md),
[helper contracts](../tests/test_optimisation.py) and
[flow acceptance](../tests/test_optimisation_example.py). Browser-fetch mutation
journalling remains an explicit transport limit; this implementation uses proven
browser operations and the supported standalone HTTP executor.

## Decision

Extend the flow authoring skill to answer:

> What is the quickest safe execution that accomplishes the operator's objective,
> preserving its required guarantees and evidence, using what we already know?

Operational automation specifies the requested effects and assurance, such as
assigning ownership to 100 records and verifying each persisted assignment.
Testing additionally specifies the behaviour and boundary to exercise. A
shortened flow must preserve whichever objective the operator actually supplied.

Start with an existing proven flow, its application bindings and retained
evidence. The agent proposes omissions and explicit transport substitutions,
authors ordinary Python/Robot flows, then compares measured executions against
the objective's evidence obligations. Exploration may require agent judgement;
execution uses normal keywords and enforced prerequisites. There is no new
workflow DSL, scheduler or runtime replanning.

Whole-flow equivalence is useful when the entire flow is under test. Otherwise,
the objective determines which behaviour must still be exercised and which setup
can be shortened. Speed cannot compensate for answering a different question.

## Operator interaction and evidence

The operator supplies the proven flow and objective, for example:
“Reassign these 100 records and verify each saved owner; the editor UI is outside
scope.” A testing objective might instead ask whether the editor rejects an
invalid owner. Infer available bindings, contracts
and authorised execution scope from the project. Ask only for missing information
that changes the answer: principally the boundary under test or intended session
condition. Do not ask the operator to select transports or invent API mappings.

Before changing code, record a short objective with the requested action and required boundary,
actor/resource bindings, intentional input variations, required observations,
allowed setup alternatives, authentication/renewal policy and workload. This is
review material, not an executable plan. Identify code under test separately from
setup; browser setup is eligible for substitution when outside the objective.

Consider four existing browser stages: establish session, find/open the item,
edit its owner, then submit and observe persistence. Their treatment depends on
the question:

| Testing question | Legitimate shortening | Required exercise and evidence |
| --- | --- | --- |
| Does the editor reject an invalid owner? | Reuse an admissible session and known item route. | Exercise the actual editor validation with the original invalid value; retain validation evidence and required absence of persistence. |
| Does changing the owner persist? | Use a calibrated API operation and independent readback. | Verify the requesting principal, exact item/revision and requested owner, then establish the persisted change. |
| Can a creator approve their own request? | Reuse a known request and direct approval interface if UI is outside scope. | Keep creator and actor identical, attempt approval at the specified boundary, observe the application's refusal and unchanged approval state. |
| Can another user read a known private item? | Skip creation/navigation when the supplied fixture still satisfies the objective. | Establish resource privacy/ownership and the requesting user's identity; make the actual access request and check refusal and nondisclosure. Knowing an ID is not access evidence. |

Domain assertions classify each obligation as satisfied, contradicted or unknown.
The objective passes only when every required obligation is satisfied; definite
contradiction fails it, and missing required evidence leaves it incomplete. Keep
this verdict separate from mutation effects (`confirmed`, `rejected`, `unknown`):
a rejected self-approval can satisfy a negative objective. A timeout, omitted
request or local guard refusal cannot establish application refusal. An HTTP 200
or Robot PASS cannot establish an unobserved business effect.

For anonymous, expired-session or no-refresh questions, preserve that exact
condition. Establish identity/session provenance using calibrated evidence that
does not refresh or keep the session alive. An authenticated-principal prerequisite
must not prevent the target request reaching the application. Use the existing
explicit no-maintenance/no-probe policies only where the objective requires them;
retain the original session binding and application response. Unknown identity
does not become proof of the intended anonymous or expired condition.

## Reusable knowledge and fresh state

Keep application mappings in the consumer's existing adapters: routes, payload
construction, selectors, identity probes, causal prerequisites, resource bindings,
effect observers and supported authentication/idempotency contracts. Reuse these
without rediscovering the application on every run.

A small knowledge index references those code definitions and their calibration
evidence. Each entry records application/environment scope, flow/adapter/runtime
versions or fingerprints, operation and transport, applicable objective boundaries,
dependencies, evidence provenance/date and invalidation conditions. Mark claims
as observed, inferred or unverified. Inferences can suggest experiments; only
observed and calibrated alternatives become executable candidates. Keep raw
captures and credentials private; the public library ships synthetic examples.

Durable knowledge describes *how to check or perform* an operation. It does not
certify today's principal, cookie/token state, resource ownership/revision,
transaction outcome or permission. A retained resource ID can eliminate lookup;
its required relationships and current state still need appropriate evidence.
Never replace an intentionally stale revision or invalid binding with a fresh,
valid value.

Invalidate affected entries after a material mapping/version change, failed
contract observation or changed authentication semantics. A generic timeout is
insufficient evidence of drift. Recalibrate only the affected contract. Existing
`watch`/`watch_runtime` guards detect opted-in implementation changes during a run;
they are not remote-application attestation. `check_contract` compares an explicit
fresh observation with an expectation before its dependent action. Do not infer
current validity solely from an unchanged file hash or recent calibration date.

## Skill workflow and small helpers

1. **Read the objective and baseline.** Inspect actual native composition and
   bindings, retained run evidence and unresolved operation journals. Reuse a
   suitable baseline profile; execute a new baseline only when needed and within
   authorised scope.
2. **Explain the cost.** Use outer wall time and diagnostic timings/counts to
   identify navigation, login, fixed waits, repeated lookup or redundant setup.
   Nested timings overlap; summing them does not measure elapsed time.
3. **Propose one small candidate.** For each retained, replaced or omitted step,
   state the objective obligation, causal prerequisite, supporting knowledge,
   transport, expected saving and fresh checks still required. Preserve order
   where state or transactions depend on it. Replace fixed waits with calibrated
   bounded read-only observations, never mutation polling.
4. **Author and check normal flows.** Reuse domain keywords or add a calibrated
   keyword in the consumer adapter. Preserve the baseline and show a code diff.
   Check synthetic contracts first, then explicitly execute comparable runs.
5. **Compare and retain.** Report objective coverage, challenge results, timing
   distributions and limitations. Publish no speed claim from an estimate.
   Retain the candidate only for the validated objective/workload scope.

Two offline helpers support the authoring workflow:

- `summarise_profile(run_directories)` reads existing diagnostics and runner
  records, returning outer durations, boundary timings/counts, cached returns,
  incomplete telemetry and source references. It performs no application calls.
- `compare_objective_runs(objective, baseline_runs, candidate_runs)` checks
  coverage of named obligations and comparable workload metadata, consuming
  domain-produced verdicts and evidence references. It reports missing evidence,
  effect/cached-receipt distinctions and timing differences; it cannot infer
  business correctness from status codes.

Diagnostic operation/target references are keyed per run, so offline helpers
cannot reverse them into native keywords or journal IDs. Accept an explicit
private link index recorded by the application during execution, or report only
aggregate costs when it is absent. Do not export the diagnostic key or expose
credentials to recover readable labels. Safe events do not reconstruct mappings.

The agent reads knowledge and writes code directly; no general dependency solver
or plan interpreter is needed. Helper records contain evidence and analysis,
never dispatch instructions. Import, inspection and dry-run stay passive.
Calibration probes and mutations are separate explicit native executions under
existing authorisation. Request further permission only when required actions
exceed that scope, not for every optimisation step.

## Transports, actors and transaction safety

Choose the transport when authoring the candidate. Browser interaction remains
where browser behaviour is under test. Browser-session `fetch` can avoid UI
navigation while retaining the page's origin/session. Standalone `HttpSession`
can avoid browser startup only when authentication acquisition and application
semantics support it. Other interfaces require equally calibrated contracts;
direct persistence inspection may provide evidence but cannot replace an
application access check. Independent readback may use a different interface when
the objective allows it; it must observe state rather than echo submitted values.

For each alternative, document credentials, CSRF rotation, cookie scope,
origin/redirect policy, request semantics and evidence collection. Cookie import
requires a complete bound snapshot and subsequent HTTP-principal verification
when admissible. It neither reproduces browser SameSite navigation policy nor
supports partitioned-cookie replay. Bearer/local-storage state and CSRF handling
need explicit application-owned mappings. Never overwrite a newer HTTP jar with
an older browser export. Browser launch/export costs belong in cold-run timing.

Keep distinct actors in isolated sessions/jars with explicit generations and
resource relationships. Share authentication only through the configured owner
of that actual grant. Do not switch to an account that makes the action succeed.
Normal mutations check identity and original resource prerequisites inside the
dependent operation; server revision/conditional-write semantics must address
concurrent change where required. A preflight read alone does not remove that
race. Renewal follows the objective and `AuthenticationOwner`, including its
unknown-callback reconciliation; it cannot repair input bindings.

Use `OperationExecutor` for supported standalone HTTP mutations: persist stable
logical operation ID and immutable intent before dispatch, retain dispatch
reservations, and assess/reconcile effects through calibrated observers. Its
prerequisite callback runs after the principal check and before reservation; a
resource observer must not reenter the leased HTTP session.

Unknown effects stop dependent work. Do not fall back to browser submission after
an uncertain API dispatch, or mint a fresh ID to bypass the journal. Explicit
`reconcile_only` can observe unresolved effects without authentication preparation,
renewal or another mutation; observation may remain unknown. Replay requires
authoritative evidence that the original operation had no effect, or a
server-supported idempotency contract covering the exact request and remaining
retention window.

A fallback is a separately reviewed native branch, initially limited to a known
pre-dispatch failure with preserved prerequisites and no unresolved effect. It
must not turn an intended denial into a successful alternative. Material drift
stops new dependent actions and retains evidence for authoring-time repair;
runtime does not discover a replacement endpoint or replan.

## Comparison and challenge gates

Compare executions that answer the same question with comparable fixtures and
binding variations, rather than demanding identical UI traces. Baseline and
candidate mutations use separately authorised comparable transactions/resources
and distinct IDs. Reusing an ID can return a historical cached receipt; changing
an intent under that ID is refused. Neither measures a new candidate execution.
Resuming the original transaction always retains its original ID and intent.
Cached confirmed/rejected receipts, including from `reconcile_only`, are not fresh
state observations.

Before timing, require the smallest relevant challenge set:

- Wrong actor, swapped resource and unexpected revision stop ordinary dependent
  actions; deliberate negative bindings reach the specified application boundary.
- Expired/anonymous/no-refresh variants preserve the requested condition and
  distinguish local refusal from application response.
- A commit followed by lost response remains unknown until reconciliation and
  never causes duplicate writes or browser fallback.
- Material contract drift stops dependent dispatch; missing/truncated evidence
  cannot produce a passing objective.

Exercise real keyword composition and count dispatches/effects in the synthetic
fixture. Select gates relevant to the changed boundary; successful response
equality alone does not qualify a candidate.

Measure cold and warm runs separately, including launch, authentication,
state transfer, required checks/readback and teardown under the same convention.
Use matched repetitions, report sample counts, median and spread, failures and
incomplete observations. Retain outer elapsed time when telemetry is incomplete,
but mark unavailable cost attribution. For 100 bindings, report total time and
per-binding distribution plus one-time calibration/setup cost and amortisation.
Reuse knowledge and admissible sessions, while retaining each binding's identity,
resource, transaction checks and intentional variations. No universal performance
threshold is proposed; improvement must be measured for the declared workload.

## Current capabilities and implementation gaps

The inspected implementation supplies these foundations:

| Existing code | Capability and limit |
| --- | --- |
| [diagnostics.py](../src/treadway/diagnostics.py), [diagnostics guide](../src/treadway/authoring/skill/treadway-flows/references/DIAGNOSTICS.md) | Run timings/events/counts, explicit implementation and contract guards, bounded asynchronous sinks. Optional telemetry does not replace mandatory execution journals. |
| [sessions.py](../src/treadway/sessions.py), [recovery.py](../src/treadway/recovery.py) | Isolated complete cookie jars, principal probes, bounded observations; authentication ownership, immutable intent, dispatch reservations and explicit recovery. Application mappings/assessments remain consumer responsibilities. |
| [actors.js](../src/treadway/browser/actors.js), [request-observer.js](../src/treadway/browser/request-observer.js) | Browser-session fetch/principal checks and correlated request/response evidence. The observer does not reconstruct complete replay payload/header/auth recipes; actor requests do not have the executor's durable mutation journal. |
| [form-assessor.js](../src/treadway/browser/form-assessor.js), [prepared-edit.js](../src/treadway/browser/prepared-edit.js), [interactions.js](../src/treadway/browser/interactions.js), [entra.js](../src/treadway/browser/entra.js) | Context/target/prepared-value guards, bounded observation, explicit action receipts and login/state-export handling. Application identity, permissions and business effects still require calibrated bindings. |

The implementation supplies skill guidance, two helpers, knowledge/evidence
conventions and synthetic acceptance. The minimal transport gap is safe reuse of existing
consumer payload/auth contracts, not automatic conversion of captured traffic.
Do not claim resumable browser-fetch mutations until durable intent/reservation
and reconciliation are actually integrated and tested there. Initially retain a
proven browser operation or use the supported HTTP executor for a substitution.

## Delivery and acceptance

The skill produces a native flow/adapter diff, short objective and step-disposition
record, referenced knowledge with provenance, private execution journals and
evidence, and a comparison report. Record omitted steps and why their obligations
remain satisfied, measured versus estimated costs, challenge results, invalidation
conditions and outstanding unknowns. Consumers supply bindings to the proven flow;
they do not invent alternate execution paths for each invocation.

1. Build one disposable synthetic end-to-end case: four browser stages become a
   calibrated standalone owner-change operation for a persistence objective;
   choosing editor validation retains its UI action. Acceptance requires native
   execution, objective evidence, dispatch counts and the relevant challenge gates
   above, followed by measured cold/warm comparison without a promised speedup.
2. Add the offline helpers and skill workflow around that case; verify analysis
   performs no network or mutation and incomplete evidence cannot pass comparison.
3. Validate reuse across 100 distinct bindings, multiple actors and session expiry.
   Extend transports only when a concrete consumer contract justifies the work.

Application-specific questions remain explicit: which interfaces exercise the
boundary, which observations authoritatively establish effects or absence, and
which session/fixture state may be reused. Missing answers constrain the candidate
to proven operations until calibrated; they do not justify weakening the objective.
