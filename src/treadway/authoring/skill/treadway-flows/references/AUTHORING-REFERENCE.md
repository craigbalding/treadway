# Application adapter reference

Use [Build a flow](AUTHORING.md) for the working example. This reference covers
configuration, API behaviour and limits.

## Adapt another application

Pin the application version and start with one ordinary flow. Record actual
users, roles, relationships and returned resource IDs. Keep fixture-setup access
separate from the intended flow actor, and establish that actor in the actual
browser before mutations. Inspect all relevant actions, inputs, constraints,
feedback and dialogs; suggested selectors still require calibration against the
current page.

Implement small domain operations with current-state guards, explicit sourced
inputs, one intentional action and post-state observations. Return structured
bindings between native Robot keywords. Treat these handles as immutable: pass
input variations as operation arguments rather than editing a handle's ID, path,
revision or evidence. Compare issued values with current authoritative state
inside each dependent operation; do not silently refresh a stale binding.

Choose expected properties independently of the response being tested. Give the
observer enough visibility to establish them, including intended cross-user or
ownership relationships. A prerequisite establishes the actor, inputs and current
state; it must not assume the application decision under examination. Robot PASS
covers executed keyword contracts, not an omitted business action.

After the ordinary flow is proven, select a reusable checkpoint and recheck it
before each deliberate variation. Return the updated binding afterward. If a
variation consumes or changes the prerequisite, use an explicit verified reset or
a fresh fixture. Preserve the chosen stimulus instead of silently sanitizing it.
An expected rejection needs an actual valid request shape, the intended state
and an effect observation. A helper refusing invalid input establishes an unmet
prerequisite; testing the application's handling of that input requires a separate
explicit stimulus operation that permits it.

Prepare lengthy pickers or panels separately from commit, then recheck the
resource and prerequisites before one dispatch. Poll only read-only observations
within a declared window. Retain transient and contrary observations, incomplete
results and uncertain cleanup obligations. Reconcile actual effects through the
application's observer before deciding on recovery; opening a new run or retrying
a mutation must not erase an unresolved obligation. Record source/input versions
for each run, and retain failed evidence rather than rewriting an earlier trial.

## Fast checks and diagnosis

```sh
python run.py check                         # overall 15-second budget
CHROME_BIN=/path/to/chromium python run.py test
CHROME_BIN=/path/to/chromium python run.py test --suite handoff.robot
python run.py check --budget-seconds 10
```

`check` runs Python contracts, Node contracts and syntax, then Robot dry-run over
all root `.robot` files. It discovers Python `test_*.py` contracts and Node
`*.test.js`/`*.test.cjs`/`*.test.mjs` or `test_*` contracts under `tests/`. New
matching contracts are included automatically. It launches no app or browser. A missing dependency or
failed contract is a failure, not a skip. Imports and library constructors must
remain passive. Dry-run cannot prove selectors, readiness or persistence.
`test` includes `check`, starts fresh local resources, runs the chosen Robot suite
and verifies the database is empty after scoped teardown. Its default whole-run
budget is 60 seconds; choose explicit `--budget-seconds` (1–120) when justified.
Cleanup can take up to five seconds after an observation deadline.

Every invocation writes a new private `artifacts/check-*` or `artifacts/test-*`
directory. Start with `summary.json` and the failed check's log. Completed checks remain in the
summary when a later check fails; failed/incomplete checks retain their own status
and log. Browser summaries include the actual browser-command elapsed time. Browser acceptance
also retains `robot/output.xml`, `domain.jsonl`, `attempts.jsonl`, the SQLite
database and source hashes. Retain red evidence; rerun creates a new directory.
`liveConditionsVerified` is true only after the selected local browser suite and
cleanup pass. It makes no statement about any external application.

For a changed controller or old matching option, test readiness against the old
query/actual ID before running the browser. For a stale resource, compare the
issued binding with current authoritative state. If a mutation times out, inspect
its actual effect before considering another mutation. The reference journals
created IDs before later observations, allowing teardown to recover interrupted
creation. Domain cleanup failure fails the run and retains the database.
