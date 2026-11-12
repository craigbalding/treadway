# Browser backend comparison

An optional, synthetic, loopback-only experiment comparing current Treadway
mechanics with **Robot Framework Browser 21.0.0**, using its supported JavaScript
extension API and Playwright 1.64.1. This directory is not shipped in the Python
package and adds no production dependencies. No production backend is changed.

The shared React 18.3.1 and Vue 3.5.45 fixtures are exercised unchanged. The third
fixture uses the actual **Element Plus 2.14.8** remote, filterable, teleported
select. That is one calibrated component, not a compatibility claim for the whole
kit. All assets are installed locally before testing; runtime uses no external
website, credential provider or account.

## Setup and run

From the repository root, with Python 3.13 and Node 22 available:

```sh
python3 -m venv .venv-comparison
.venv-comparison/bin/python -m pip install -r experiments/browser-comparison/requirements.lock
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix experiments/browser-comparison
.venv-comparison/bin/rfbrowser init --skip-browsers
```

Install the Chromium headless shell matched to the installed Browser Playwright
version (the recorded trial used revision 1248, Chromium 156.0.8078.4). One explicit
way, avoiding a system Chromium or driver-version mismatch, is:

```sh
PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" \
  node .venv-comparison/lib/python3.13/site-packages/Browser/wrapper/node_modules/playwright-core/cli.js \
  install chromium --only-shell
export CHROME_BIN="$HOME/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell"
export COMPARISON_PYTHON="$PWD/.venv-comparison/bin/python"
export TREADWAY_PYTHON="$COMPARISON_PYTHON"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
```

Preserve proxy and CA environment settings. The browser must support sandboxed
execution; do not substitute `--no-sandbox` to get a green comparison. For a
different Python minor version, adapt the site-packages path above.

Run one targeted pair first, then the repeated matrix:

```sh
COMPARISON_ROUNDS=1 COMPARISON_FRAMEWORKS=react node experiments/browser-comparison/run.cjs
node experiments/browser-comparison/run.cjs
node experiments/browser-comparison/integration.cjs
node experiments/browser-comparison/defaults.cjs
```

For a lifecycle failure, narrow the integration check with
`COMPARISON_INTEGRATION_FILTER='worker spawn'`. That check reproduces a missing
interpreter and a blocked worker, verifies bounded shutdown and requires the
forced cleanup to remain reported as unconfirmed. An unmatched filter fails.

`COMPARISON_BACKENDS=native` or `browser` narrows a diagnostic run; frameworks are
`react`, `vue`, `element-plus`. Default is three rounds of all six combinations,
alternating backend order. The full performance matrix takes several minutes;
the targeted command is the development loop. Do not run other browser workloads
concurrently with the measured matrix. Each invocation retains a new private
`artifacts/browser-*` directory, including failures. Summaries update after each
check. Do not replace an earlier failed report with a later passing run.

## What is compared

Both backends run the same scenario assertions and independent server
observations. Native uses `Autocomplete`, `DateRange`, `RequestObserver`,
`BrowserInteractions` and the existing Python browser lifecycle. Browser uses the
actual Python library over its Node/gRPC transport, with a small experimental
extension implementing the tested guarded widget subset. The JSON worker is
experiment orchestration, not a new workflow DSL or a proposed runtime API.

The matrix covers:

- A delayed query, visible old options, exact actual option ID, framework rerender
  and server-received selected ID. One query is dispatched, never polled as input.
- Controlled date input, rerender, actual complete HTTP response/body and the
  separately observed server-received values.
- Changed form target, replaced field, replaced action and wrong option ID:
  refusal before a save/selection, with no subsequent step executed.
- Alice → Bob → Alice writes to the same revisioned resource, actual cookie-based
  principal checks, and separate cookies, local storage and session storage.
- Fresh stale-revision and wrong-principal refusal with zero write requests;
  explicit self-approval, private-resource and anonymous requests that reach the
  application and receive actual 403/401 responses.
- Sandbox enabled, no `--no-sandbox` launch argument, private profile permissions,
  one browser process for three Browser contexts versus three owned profiles,
  and process/profile cleanup.

The domain guards in `run.cjs` are shared application-adapter code over fresh
principal/resource reads. They are not supplied by Browser, and do not prove
production Treadway actor lifecycle integration. The server's resource state and
received payload ledger are independent of the page, but in memory; these checks
do not establish durable database persistence or exactly-once business effects.

`integration.cjs` runs native Robot keywords and the extension on all three
fixtures. The second Robot test is deliberately expected to FAIL on a changed
target; the harness verifies its reason, absence of the following marker and
absence of a save. A green harness therefore contains one expected red Robot
test per fixture. It also attaches Browser to an owned Treadway browser, binds
the exact CDP target among two tabs, and verifies the original browser still
works after Browser detaches. All actor processes/profiles are observed and
checked after cleanup; driver object counts are not cleanup evidence.

`defaults.cjs` measures an incompatible default: Browser/Playwright dismisses an
unhandled JavaScript confirmation automatically and continues. Treadway retains
the dialog and refuses advancement. The experiment deliberately preserves that
difference. A production Browser integration must establish an explicit dialog
policy before page execution, including newly opened pages.

## Interpreting timing and parity

Both backends use a 1280×720 viewport at device scale 1. Session startup includes
browser/process startup and the first mounted fixture. Native JavaScript modules
are already loaded in the harness before that timer; Browser's Python imports,
library initialization and Node/gRPC startup happen inside it. This measures the
trial's session startup paths, not symmetrical cold library initialization.
Additional actor
setup includes two pages and two contexts or two processes/profiles. These are
different isolation strategies, so their timings are not interchangeable
security guarantees. Warm widget checks include real waits and observations;
the native clicks retain their existing explicit 100ms observation window. This
is a comparison of these implementations, not a Playwright-versus-CDP engine
benchmark. Fresh domain refusal latency is recorded separately from setup.

Passing the tested subset does not establish parity for multiselect, datepicker
popups, rich-text editors, frames, workers, uploads/downloads, interrupted bodies,
target leases/generations, persistent profiles, redirects, secret logging or
process crash recovery. The candidate retains element handles to avoid silent
selector replacement. Neither tested adapter makes a browser observation and a
server mutation atomic; authoritative server authorization/concurrency checks
still decide the result.

Read the [comparison decision](../../docs/BROWSER-COMPARISON.md) for measurements,
limits and which modules could be replaced after further validation.
