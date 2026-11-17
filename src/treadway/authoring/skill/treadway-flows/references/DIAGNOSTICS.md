# Debug a flow and its machinery

Enable diagnostics around the flow you want to inspect. Progress goes to stderr;
your script still controls stdout. The run directory retains events and timing
statistics for inspection after success or failure.

## Try the local example

From a generated project:

```sh
python debug_recovery.py --level DEBUG
```

The example runs 100 local mutations, renews a session after write 37 and confirms
a lost reply at write 63 without repeating the write. Expect progress on stderr,
a final JSON result on stdout and a private directory containing `events.jsonl`,
`summary.json` and `coverage.json`. Use `--no-console` to keep files without
terminal progress. No browser, external account or live service is used.

To see a changed application contract stop the next write:

```sh
python debug_recovery.py --simulate-contract-change-at 38
```

This command deliberately exits nonzero before write 38. The first 37 writes
and their evidence remain available.

## Python events

Wrap your own existing operations in one scope:

```python
from treadway.diagnostics import RunDiagnostics

with RunDiagnostics("artifacts/diagnostics", console=True, level="DEBUG") as run:
    for binding in bindings:
        execute_calibrated_mutation(binding)

statistics = run.summary()
```

`bindings` and `execute_calibrated_mutation` belong to your application. Shared
HTTP, authentication and browser adapters emit their events within this scope.
Without a diagnostics scope, they create no diagnostic files, output or threads.

INFO shows operation progress. DEBUG adds HTTP, identity-probe, subprocess and
CDP details. For your own display, pass `sinks=[callback]`; the callback receives
structured metadata with no payloads, credentials or page text. Standard Python
logging is available through `treadway.events`. See [event delivery](DIAGNOSTICS-REFERENCE.md#event-delivery)
for buffering, dropped events, callback failures and private journal access.

## Robot logs

From a generated project:

```sh
python -m robot --pythonpath . \
  --listener treadway.diagnostics_robot.DiagnosticsListener:artifacts/diagnostics:DEBUG \
  --loglevel DEBUG --outputdir artifacts/robot session_recovery.robot
```

The listener prints progress to stderr and adds structured messages to Robot's
normal result and `log.html`. One listener owns the suite's run. Its arguments
are output directory, level, optional runtime guard (`false` by default) and an
optional comma-separated list of application flow files.

## Read a result or stop on a change

Start with `summary.json` for elapsed time, operation counts and incomplete
delivery; use `events.jsonl` for the sequence. Timings can overlap, so do not add
nested timings to calculate wall time. Diagnostic counts do not prove business
completion; keep the operation's original journal and saved-state checks.

For watched files, set `watch=["adapter.py"]` and optionally `watch_runtime=True`.
For an observed application requirement, use `run.check_contract(...)` before
the dependent action. [Change guards](DIAGNOSTICS-REFERENCE.md#report-changes-precisely)
explain what each check establishes and how to reconcile an earlier uncertain
write. Logging alone does not enable a guard, and a timeout alone does not prove
the application changed.
