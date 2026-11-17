# Flow comparison and transport reference

Use [Optimise a flow](OPTIMISATION.md) for the working example. This reference covers
configuration, API behaviour and limits.

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
