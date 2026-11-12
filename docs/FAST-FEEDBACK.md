# Fast feedback

Start with the smallest check that can expose the changed behavior. Keep code
feedback separate from application startup. A local contract failure should not
require booting a real application or waiting for a complete workflow suite.

## Developing this library

Run these commands from the Treadway checkout, using its development dependencies:

```sh
# Choose the affected Python module or Node contract first.
python -m pytest -q tests/test_widget_results.py
node --test tests/test_widget_guards.js
python -m pytest -q tests/test_browsers.py tests/test_sessions.py
node --test tests/test_actor_contracts.js tests/test_target_sessions.js
python -m pytest -q tests/test_credentials.py tests/test_credentials_robot.py

# Broader local mechanics and both real framework smoke cases.
npm test
CHROME_BIN=/absolute/path/to/chromium npm run test:browser:fast
```

The framework smoke cases launch isolated local React/Vue fixtures. They hold a
query response until old results are observed, then release it and replace the
controlling node. They check actual controlled-state persistence, exactly one
query request and rejection of a changed native form target. Missing Chromium
is reported as a skip by the browser test; that is not successful calibration.
The same fast command also checks real origin-state clearing and worker request
capture through the shared sandboxed browser launcher.

Use the complete browser/Robot suite when changing those boundaries:

```sh
CHROME_BIN=/absolute/path/to/chromium FORM_REACT_FIXTURE_ROOT="$PWD" \
  FORM_ROBOT_PYTHON="$(command -v python)" npm run test:browser
python -m pytest -q
```

For changes to shipped assets, also build and install a wheel in a separate
virtual environment, install its locked Node dependency, and verify that the
checks load the installed implementations. The [README](../README.md) documents
installation; [validation](VALIDATION.md) distinguishes recorded checks, skips
and limits. These commands require only this repository and its dependencies.

## Authoring a flow

The installed package exports a self-contained reference project:

```sh
treadway new my-flow
cd my-flow
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite handoff.robot
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

The generated project's `check` has a **15-second overall budget** and starts no
app or browser. It discovers local Python/Node contracts, checks syntax and runs
native Robot dry-run. Its `test` command adds an isolated loopback app and browser
with a **60-second overall budget**. Results stream as checks finish. Each run
retains a private summary and logs, including earlier checks when a later one
fails, explicit incomplete checks and browser-command duration.

Use a focused local regression before a browser flow. In the generated project,
`node --test tests/adapter.test.cjs` exercises query readiness and actual-ID
selection. Run the affected Robot suite next, then broader acceptance after it
passes. [The authoring guide](AUTHORING.md) covers application mappings, effect
observers, reusable checkpoints, deliberate variations and cleanup.

## Diagnosing failures

Reproduce the observed transition, including pending results, stale values and
changed controller bindings. A matching option left over from an earlier query
is insufficient. Prefer explicit response gates and actual identity checks to a
fixed sleep. Polling callbacks observe state; they must not repeat a mutation.

Retain the failed evidence and add a small regression before the fix. Verify that
the failure stops dependent native Robot steps and independently observe any
actual effect. Keep the original input, guard and acceptance rule intact unless
the task explicitly changes them. A timeout stops waiting; it does not prove a
previously dispatched action was rejected or absent.

Consumers own application startup and health diagnostics. Reuse a healthy running
instance for an affected probe, report bounded readiness observations and make
long waits explicit. Process activity alone does not establish service health.
Application-specific lifecycle scripts and acceptance records belong with that
integration rather than in this library.
