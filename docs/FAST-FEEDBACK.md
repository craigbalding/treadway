# Get fast feedback

Run the smallest check that can expose the change, then the affected browser
flow. Keep the first failure's logs. A retry starts a new attempt; it must not
erase an uncertain application effect.

## While writing a flow

From a generated project:

```sh
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite handoff.robot
```

`check` starts no app or browser and has a 15-second budget. `test` includes those
checks, starts local resources and has a 60-second budget. Replace `handoff.robot`
with the suite you changed. Results print as each check finishes.

Open the printed `summary.json` and failed check's log. For a mapping problem,
start with its local test, such as `node --test tests/adapter.test.cjs`. Reproduce
the pending query, changed control or stale resource that failed; a steady page
may not reproduce it. [Screenshots and diagnostics](OBSERVABILITY.md) help when
execution reached the browser.

## While developing Treadway

From a checkout with `.[dev]` and locked Node dependencies installed:

| Change | First check |
| --- | --- |
| Widget result or input guard | `python -m pytest -q tests/test_widget_results.py`; `node --test tests/test_widget_guards.js` |
| Browser or HTTP session | `python -m pytest -q tests/test_browsers.py tests/test_sessions.py` |
| Session recovery | `python -m pytest -q tests/test_recovery.py` |
| Credentials | `python -m pytest -q tests/test_credentials.py tests/test_credentials_robot.py` |
| Entra | `npm run test:entra`; `python -m pytest -q tests/test_entra_robot.py tests/test_entra_cookies.py` |
| Diagnostics or optimisation | `python -m pytest -q tests/test_diagnostics.py tests/test_optimisation.py` |

Then run broader contracts and the affected browser check:

```sh
npm test
CHROME_BIN=/absolute/path/to/chromium TREADWAY_PYTHON="$(command -v python)" npm run test:browser:fast
CHROME_BIN=/absolute/path/to/chromium TREADWAY_PYTHON="$(command -v python)" npm run test:entra:browser
```

Browser checks use synthetic local fixtures with the sandbox enabled. A skip for
missing Chrome is not a successful browser check. Run stages serially when
checking timing-sensitive subprocess tests.

For the full browser/Robot boundary, use:

```sh
CHROME_BIN=/absolute/path/to/chromium \
  TREADWAY_PYTHON="$(command -v python)" \
  FORM_ROBOT_PYTHON="$(command -v python)" \
  FORM_REACT_FIXTURE_ROOT="$PWD" npm run test:browser
python -m pytest -q
```

For shipped assets, also exercise an installed wheel. [CI and releases](RELEASING.md)
explain the exact package checks; `.github/scripts/test_installed.sh` runs them
with a fresh wheel environment and `CHROME_BIN` configured. Structural checks and
synthetic fixtures do not replace a real application's acceptance flow.
