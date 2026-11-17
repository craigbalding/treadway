# Diagnostic events and change guards reference

Use [Debug a flow](DIAGNOSTICS.md) for the working example. This reference covers
configuration, API behaviour and limits.

## Event delivery

For standard Python logging, configure the `treadway.events` logger; each record
has `record.treadway_event`. Treadway installs no root logger handler. Supply
`sinks=[callback]` for a custom formatter or event consumer. A sink receives only
allowlisted metadata: no payloads, cookie/header values, URLs, selectors, page
text or exception messages. Correlation references are keyed per run, so simple
dictionary matching cannot recover predictable IDs. Operation IDs and raw
observations remain available through the existing private journals.

Sinks run through a bounded asynchronous queue outside execution locks. A full
queue drops telemetry and increments `dropped_events`. A raising sink is disabled
and counted; a hanging sink cannot block execution or context exit indefinitely.
`flush_seconds` bounds final delivery waiting (default 1, maximum 5). A summary
reports pending delivery and incomplete telemetry rather than claiming all
events were saved. Callbacks must still be suitable for the selected environment.

This optional telemetry does not weaken mandatory intent/evidence persistence:
if that journal cannot be written, the existing operation still stops dispatch.
Diagnostic files are not a replacement for those execution journals.

## Statistics: work performed versus business effects

`run.summary()` and `summary.json` include duration, event counts, operation
outcomes, cached returns, HTTP transport handoffs, dispatch reservations, principal
checks, authentication preparation/renewal/reconciliation counts, observed HTTP
statuses and timing count/total/max for each measured boundary.

A reservation is not a transport handoff. A CDP command is not a business write.
A cached confirmed receipt is a historical result, not another server effect.
Business confirmation still comes from the application's calibrated observer.
Nested timings overlap: do not sum them as wall time. Counts describe observed
work in this process; they are not a complete network monitor or provider audit.

Subprocess events carry parent-assigned producer identity and sequence numbers.
Malformed/out-of-order messages and missing producer completion make telemetry
incomplete. A killed subprocess cannot turn an uncertain mutation into a proven
rejection. Raw stderr stays in the private transport result and is never copied
unconditionally to safe console output.

## Report changes precisely

Logging and change enforcement are independent. `watch`/`watch_runtime` explicitly
enable checkpoints; merely enabling diagnostics does not add a guard.

Watched files are fingerprinted at run entry. Before a new dependent mutation or
authentication callback, a changed fingerprint raises a distinct `FlowChanged`
precondition. Python AST fingerprints ignore comments and formatting. Other files
use content bytes conservatively. This proves an `implementation_changed` fact,
not that the remote application's workflow changed. Coverage/fingerprints and
their file mapping are private in `coverage.json`. This is disk checking, not
loaded-code attestation; it does not eliminate every check-to-dispatch race.

For a real application contract, compare an actual observation immediately before
its dependent action:

```python
run.check_contract("resource-revision", expected=original_revision,
                   observed=observed_revision)
```

A material mismatch stops the dependent action. Expected/observed values are
retained privately when an output directory is configured; safe events expose
only opaque references. Use `material=False` for a documented nonblocking
difference. Existing observed form/context/native-target/choice/prepared-edit
guards also report recognized mismatches through the browser bridge. A generic
timeout or unknown screen alone does not establish application drift.

If an earlier mutation may already have committed, its effect stays unknown.
Use `executor.reconcile_only(operation_id)` for the calibrated read-only observer
without authentication preparation, renewal or mutation dispatch. Non-GET
`HttpSession` requests are refused in that scope. If authentication is unavailable,
observation may remain unknown; do not escalate into a login or replay implicitly.

Contexts are local to the Python execution context. Subprocess propagation is
explicit in the shared adapters. For unrelated worker threads or independently
launched Node programs, establish/carry their own explicit diagnostics context;
do not assume a global logger establishes run ownership or identity.

Completed subprocess producers are retired as needed. If the bounded producer
registry is exhausted by unfinished children, guarded launches stop rather than
dropping the guard; unguarded telemetry is marked incomplete. Python AST
normalization applies to parent checkpoints; a browser child's inherited file
baseline is conservatively checked as content bytes at its action boundaries.
