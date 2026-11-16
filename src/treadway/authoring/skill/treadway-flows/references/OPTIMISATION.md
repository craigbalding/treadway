# Optimise a flow for the operator's objective

Start with the operator's objective:

> What is the quickest safe execution that accomplishes the operator's objective,
> preserving its required guarantees and evidence, using what we already know?

Read the proven native flow and its bindings before choosing a transport. For
operational automation, identify the requested effects and assurance requirements:
for example, reassign 100 records as the authorised user and verify each saved
assignment. For testing, identify the specific behaviour and boundary that must
be exercised. In both cases, preserve the intended actors/resources/session
conditions, input variations and required observations. Infer these from the
request and project; ask only where missing information materially changes the
objective. Keep this short objective as review material.

## Reuse knowledge and remove unnecessary work

Existing routes, field-to-payload mappings, causal prerequisites, identity probes,
effect observers and authentication contracts can eliminate repeated discovery,
navigation and setup. Keep these mappings in consumer adapters. Record their
application/environment scope, source/runtime identity, calibration evidence,
dependencies and invalidation conditions in a small knowledge index. Mark claims
observed, inferred or unverified; inferred alternatives require calibration before
they become executable candidates.

Knowledge of how to save an item can eliminate opening the form. It does not
establish today's requesting principal, resource revision, permission or outcome.
Retain the checks required at the dependent operation. Never repair a deliberate
invalid owner, stale revision, expired credential or anonymous session. A local
guard's refusal cannot prove that the application refused a submitted request.

For each existing step, record retain/replace/omit, the obligation it serves, the
knowledge permitting that choice and the fresh checks still required. Preserve
causal ordering, intermediate effects and transaction boundaries. Use bounded
read-only observations in place of arbitrary waits. Parallelise only operations
whose independence has been established.

| Operator's objective | Example optimisation |
| --- | --- |
| Assign the new owner to these records and verify each assignment. | Use known bindings, a journalled HTTP operation and independent readback; retain per-record identity/revision checks and recovery. |
| Does the editor reject an invalid owner? | Reuse a valid session and known item route; retain actual UI input and validation. |
| Does the new owner persist? | Use a calibrated HTTP write and independent readback; browser navigation may be omitted. |
| Can the creator approve their own request? | Attempt approval as the verified creator, retaining application refusal and unchanged-state evidence. |
| Can another user read a known private item? | Skip discovering its ID; establish privacy/ownership and the requesting user, then observe the actual access decision and nondisclosure. |

Separate the objective verdict from mutation effects. A rejected self-approval
may satisfy the objective. Required observations are satisfied, contradicted or
unknown; missing evidence leaves the objective incomplete. Status codes, elapsed
time, cached receipts and Robot PASS do not establish missing business facts.

## Run the complete synthetic example

Export a project with `treadway new my-flow`, then enter it. All commands below
use a disposable local application with invented identities. They accept no live
target. Imports, `--help`, `--describe` and analysis helpers are passive.

```sh
python optimise_flow.py --describe --objective persistence
python optimise_flow.py --bindings 100
CHROME_BIN=/path/to/chromium python optimise_flow.py --objective validation
CHROME_BIN=/path/to/chromium python optimise_flow.py --benchmark --repetitions 2
```

The proven baseline establishes a session, finds/opens an item, edits its owner,
then submits and observes it. `--objective persistence` performs the operational
owner assignments and verifies their results using a journalled HTTP
operation using known bindings; it checks the actual HTTP identity, original
revision and contract, and observes SQLite independently. The 100-binding
standalone acceptance alternates two isolated actors, expires a session after
write 37 and loses the reply to write 63. Renewal and reconciliation preserve
exactly one write per binding. That stress injection is separate from matched
benchmark workloads.

`--objective validation` retains the editor and intentionally unknown owner. Its
candidate uses the known item route instead of list navigation, exercises the UI
refusal and independently proves zero persisted writes. It does not substitute
an API rejection for browser validation.

Benchmarking explicitly executes baseline and candidate on separate fixture
transactions. Cold runs include setup and owned teardown. Warm runs reuse their
own application/session/browser context and different resources; execution time
and measured shared preparation/teardown costs are reported separately, with
amortisation. Repetitions are matched within cold/warm cohorts. A single sample
is a measurement, not a reliable performance distribution. The default two
repetitions keep the walkthrough bounded; use additional authorised repetitions
when assessing a real workload. Browser launch and challenge gates take time.

Each invocation prints a final JSON result to stdout. Private ignored artifacts
include the objective, step dispositions, source/runtime identity, domain
observations, immutable intents, receipts, challenge evidence, diagnostics,
knowledge index and comparison. Raw browser transport results remain private.

The native implementation is in `optimise_flow.py`, `optimisation_fixture.py` and
`optimisation_browser.cjs`. Reuse those application patterns rather than copying
CDP input/navigation or writing a plan interpreter. The browser reservation is
a conservative consumer-specific one-shot guard, not a new general browser
mutation executor. It refuses reentry; it cannot silently switch to HTTP after
an uncertain browser action.

## Use the two offline helpers

```python
from treadway.optimisation import summarise_profile, compare_objective_runs

profile = summarise_profile(["artifacts/run/diagnostics/RUN_ID"])
comparison = compare_objective_runs(
    "artifacts/objective.json",
    ["artifacts/baseline-cold", "artifacts/baseline-warm"],
    ["artifacts/candidate-cold", "artifacts/candidate-warm"],
)
```

Or use the installed CLI:

```sh
treadway-optimise profile artifacts/run/diagnostics/RUN_ID
treadway-optimise compare --objective artifacts/objective.json \
  --baseline artifacts/baseline-cold artifacts/baseline-warm \
  --candidate artifacts/candidate-cold artifacts/candidate-warm
```

`python -m treadway.optimisation` exposes the same commands. Helpers read local
records only; they never execute a flow, access credentials or renew a session.
Compare exits 0 for a qualified comparison, 1 for incomplete/failed evidence, and
2 for invalid input. A qualified comparison can show the candidate was slower.

`summarise_profile` consumes `RunDiagnostics` directories. It reports outer
durations, boundary timings/counts, cached returns and incomplete telemetry.
Nested timings overlap and must not be summed. Opaque per-run references cannot
be reversed after execution. For labelled operation attribution, the consumer
may write private `links.json` while that diagnostics run is active:

```python
from treadway.diagnostics import reference
# Inside the active run; use a short generic label, never a credential.
index = {"version": "treadway.profile-links/1", "run_id": run.id,
         "operations": {reference(operation_id): "save-owner"}}
```

Persist that index privately next to `summary.json`; the example demonstrates a
durable writer. Without it the helper reports aggregate costs. Never export the
diagnostic key to recover labels. Optional missing telemetry limits attribution;
it does not erase separately retained wall time or replace mandatory evidence.

## Author comparison records

The example is an executable template for these small JSON records:

| Record | Required meaning |
| --- | --- |
| `treadway.objective/1` | Operator's goal/question, named obligations with required boundaries, intended conditions, logical workload bindings/actors/values, mutation flag, declared cold/warm modes and required challenge IDs. |
| `treadway.objective-run/1` | Unique run/transaction scope, objective/workload fingerprints, actual implementation subject/digest, environment, conditions/fault workload, variant, matched pair/mode, outcome, measured timing convention and per-binding durations, evidence references. Warm samples include measured shared costs and sample count. |
| `treadway.objective-evidence/1` | Current complete observation bound to that run, logical binding, named obligation and required boundary, domain verdict and private facts. |
| `treadway.transaction-evidence/1` | Receipt bound to run, binding, actual operation ID/scope and immutable-intent fingerprint. Historical or unresolved receipts cannot stand in for a fresh tested action. |
| `treadway.challenge/1` | Named challenge result for the exercised implementation subject/digest, environment and objective; complete calibrated facts. Browser guards require browser evidence. |

References carry a run-local relative path and SHA256. Helpers verify the exact
bytes they parse, reject paths escaping the run directory and check provenance
and required coverage. Domain observers still own semantic truth; the helper
cannot establish correctness from an adapter's unsupported assertion. Records
are analysis and evidence, never dispatch instructions.

Use distinct scopes/IDs for separately authorised benchmark transactions. Resume
an original transaction with its original ID and intent; changing either to
escape unknown state is invalid. Do not benchmark a cached historical receipt as
a new execution. Evaluate one candidate implementation per comparison side.
Report sample counts, median/spread, failed/incomplete runs, shared reuse cost,
one-time calibration cost and the scope of validated workload.

## Preserve safety when substituting transports

Browser-session fetch retains its page/session but still requires calibrated
request semantics. It does not currently have `OperationExecutor`'s durable
mutation journal. Use a proven browser keyword or supported standalone executor
until that boundary is integrated and tested. Captured network evidence is not
automatically a replayable request recipe.

Standalone HTTP needs explicit authentication, complete bound cookie state and
application-owned bearer/CSRF handling. Verify the principal through the client
that will perform the action when the objective permits that check. HTTP cookie
replay does not reproduce browser SameSite navigation or partitioned cookies.
Retain isolated actors and grant ownership; renewal cannot change semantic input.

For intentional expired/anonymous/no-refresh tests, preserve the requested
condition and observe the application boundary without a healing login or
prerequisite that suppresses the request. Retain session provenance; unknown
identity is insufficient evidence of the intended condition.

An uncertain dispatch stops dependent work. Reconcile the original operation
read-only; do not submit again through another transport. Permit replay only
under the calibrated no-effect or server-supported idempotency contract. A
fallback branch needs a proven pre-dispatch failure, no unresolved effect and
preserved objective/prerequisites. Material contract drift stops execution for
authoring-time repair; a timeout alone does not prove drift.

Run the smallest affected contract/fault checks first, then the actual changed
browser/HTTP boundary and installed-package example. Claim savings only from
comparable observed executions. Keep the baseline and show the native code diff
alongside each omission's rationale and invalidation conditions.
