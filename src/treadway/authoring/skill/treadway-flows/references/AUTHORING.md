# Build a flow with Treadway

Treadway supplies browser mechanics, JSON process transport and strict field
comparisons. Your adapter supplies application intent, identity/revision guards,
selectors, independent effect observations and cleanup. Robot supplies sequencing.

## Start from an installed package

Use Python 3.11+, Node 22+ and Chromium. Install the supplied wheel with its Robot
extra in a virtual environment; the project is an early library, so do not assume
a public package index release. Then install the locked Node runtime beside it:

```sh
python -m pip install '/path/to/treadway-0.1.1-py3-none-any.whl[robot]'
TREADWAY_BROWSER_DIR=$(python -c 'from pathlib import Path; import treadway; print(Path(treadway.__file__).parent / "browser")')
npm ci --ignore-scripts --prefix "$TREADWAY_BROWSER_DIR"
python -m treadway.authoring new my-flow
cd my-flow
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test
```

Preserve your environment's proxy and CA settings. Each browser run starts only
its own isolated Chromium profile and loopback fixture, identifies the exact
marked tab, then closes its browser and server. No Docker, existing tab, external
account is needed. `new` refuses an existing destination.
The `treadway` executable is equivalent to `python -m treadway.authoring`.

The reference workboard is deliberately synthetic and unauthenticated. Its
`fixture-author` marker tests explicit identity checks; it does not demonstrate
real authentication or authorization. Its SQLite database is independent of the
browser model. The app's supported API is in `app.py` and selectors in `app.html`
and `app.js`; these are example app code, not universal site conventions.

Follow [the walkthroughs](WALKTHROUGH.md) for step-by-step explanations of the
three executable scenarios, returned bindings and persistence evidence.
`python -m treadway.authoring guide walkthrough` prints them from an installation.

## Read and extend the project

- `flow.robot`: ordinary create/assign/schedule/note/reload flow, and a stale
  revision case that proves no plan write followed the refusal.
- `handoff.robot`: independent-agent-authored same-item reassignment, rescheduling,
  exact write counts and refusal of an old binding before the following native step.
- `adapter.py`: passive Python library; issued resource bindings, domain checks,
  bounded browser transport, independent HTTP-to-SQLite observation and cleanup.
- `browser.cjs`: actual selectors, exact option IDs, fresh resource guards and
  shared `Autocomplete`, `DateRange`, `RichTextEditor`, `PreparedEdit` and
  `RequestObserver` composition.
- `tests/`: fast pending-choice, actual-ID, revision and input-contract regressions.
- `run.py`: explicit bounded checks and local acceptance, private per-run evidence,
  source hashes, exact target selection and separate cleanup verification.

First add a new native Robot scenario using existing keywords. Choose explicit
inputs and expected properties. When the behavior needs a new domain operation,
add that operation to `adapter.py`/`browser.cjs`, with its current-state guard and
post-state observer. Keep generic reusable mechanics in Treadway. The next site
should replace application mappings and observers, rather than inherit the
reference workboard's actor, resources or semantics.

For a new flow, write down its actor, starting state, explicit action, required
persisted fields, meaningful failure and cleanup obligation. Use actual returned
IDs/revisions. Do not manufacture a successful binding from intended values.
The reference supports reassignment and rescheduling: prepare another plan using
the latest returned binding and verify the old binding is no longer usable.
`handoff.robot` is the complete example. `Reload And Verify Work Item` compares
UI fields (`ownerId`, `start`, `due`, `note`) and independently reads them back.
Use `Verify Work Item` separately for persisted-only fields such as `writes`;
those fields do not appear in the reload UI observation. Source expectations from
the requested inputs and intended write count rather than copying a response.

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

## Using the agent skill elsewhere

The scaffold includes `.agents/skills/treadway-flows/`. You can also export the
self-contained skill to your agent's skill directory:

```sh
python -m treadway.authoring skill ~/.codex/skills/treadway-flows
```

Export refuses an existing destination. Read `SKILL.md` explicitly if the chosen
agent does not discover repository skills. Skill installation grants no new
permission to operate external applications.
