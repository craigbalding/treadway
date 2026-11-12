# Treadway

**Reliable workflow execution for agents.**

Agents select intent, candidate inputs, meaningful variations and assertions.
Reusable components handle form discovery, explicit actions, runtime bindings,
bounded execution, observations and routine comparisons. Robot Framework supplies
readable executable composition; Python and JavaScript APIs remain usable directly.

This is an early library, not a stable release.

[CI and release publishing](docs/RELEASING.md) describe the fast pull-request
checks, installed-package acceptance and version-tagged GitHub downloads.

## Install and check locally

Requires Python 3.11+, Node 22+, and an isolated Chromium executable for browser
checks. Use an ordinary virtual environment and retain your environment's proxy
and CA settings.

```sh
python -m pip install -e '.[dev]'
npm ci --ignore-scripts
python -m pytest -q
npm test
CHROME_BIN=/absolute/path/to/chromium FORM_REACT_FIXTURE_ROOT="$PWD" \
  FORM_ROBOT_PYTHON="$(command -v python)" npm run test:browser
```

Browser checks launch fresh isolated local profiles and loopback React/Vue fixtures;
they do not connect to an existing browser or external application. Without
their explicit prerequisites the browser test is skipped; a skip is not calibration.

For the fast iteration loop, run `npm test` and then
`CHROME_BIN=/absolute/path/to/chromium npm run test:browser:fast`. The two local
framework checks cover delayed controller replacement, actual controlled-state
persistence and a changed native form target. Full browser/Robot and installed
package checks remain separate acceptance steps.

## Installing a wheel

The wheel includes JavaScript and a locked Node dependency manifest. In a writable
virtual environment, install the Python wheel with the `robot` extra, then install
the browser runtime's dependency beside those assets:

```sh
python -m pip install 'path/to/treadway-0.1.0-py3-none-any.whl[robot]'
TREADWAY_BROWSER_DIR=$(python -c 'from pathlib import Path; import treadway; print(Path(treadway.__file__).parent / "browser")')
npm ci --ignore-scripts --prefix "$TREADWAY_BROWSER_DIR"
```

Node resolves `ws` from that directory regardless of the caller's working directory.
The checkout-level `npm ci` is sufficient for an editable source installation.
Use `npm ci --offline` when the locked dependency is already cached. Installing a
Python wheel alone does not install Node or its dependencies. Package upgrades
require repeating the runtime dependency installation.

## Create a flow

The wheel includes an agent skill, self-contained guide, recipe index and runnable
local reference project. Start with:

```sh
treadway new my-flow
cd my-flow
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test
```

`check` has a 15-second overall budget and starts no application or browser.
`test` adds an isolated local workboard and Chromium flow within a 60-second
budget. The reference covers actual-ID assignment, guarded dates/note editing,
independent SQLite persistence, reload, stale revision refusal and scoped cleanup.
Use `python -m treadway.authoring` if the executable is not on `PATH`.

Follow [the guided examples](docs/EXAMPLES.md) to create and schedule an item,
hand it to another owner, and refuse a stale edit. The walkthroughs explain each
step and its evidence for humans and agents.

For workflows involving multiple people, follow [browser and actor sessions](docs/BROWSER-SESSIONS.md)
and run the exported `collaboration.robot` suite. It includes self-approval
refusal, cross-user private-resource access and separate anonymous sessions.
Chrome starts with its sandbox enabled; an unsupported environment requires an
explicit choice. Profiles, session generations and shutdown are managed by
`treadway.browsers`, independent of application identity and permission rules.

[Identity credentials](docs/CREDENTIALS.md) use reference-only configuration and
native Robot `Secret` values. Environment and 1Password providers are available;
optional RPA Vault and SafeYolo gateway adapters resolve explicit sources without
logging in, renewing sessions or changing actors. Run `treadway guide credentials`.

Read [the authoring kit](docs/AUTHORING.md). `treadway guide start` and `guide recipes`
work from an installed wheel. `treadway skill ~/.codex/skills/treadway-flows` exports
the standalone agent skill; generated projects also carry a repository skill.

## APIs

- `treadway.process`: bounded JSON child process and live stderr delivery; full
  incomplete payload retained on exceptions.
- `treadway.properties`: strict expected-field comparisons, distinguishing missing,
  null, different, incomplete and unknown observations.
- `treadway.browsers` and `treadway.sessions`: owned Chromium/profile lifetimes,
  exclusive operation leases and independent HTTP actor cookie jars.
- `treadway.credentials` and `treadway.credentials_robot.CredentialLibrary`:
  named credential providers and native Robot secret values, separate from login.
- `browser/actors.js`, `state.js` and `targets.js`: same-session principal checks,
  explicit origin-state operations and scoped multi-target CDP observation.
- `treadway.robot.FormLibrary`: Robot keywords over the shared browser form utility.
- `src/treadway/browser/form-assessor.js`: actions-first discovery, sourced candidate
  input/readback, explicit choices and one instrumented action with attempt memory.
- `treadway.widgets.WidgetLibrary` and `browser/widgets.js`: reusable controlled
  choices, multiselects, date ranges, plain-text rich editors and inline edits.
- `browser/interactions.js`, `request-observer.js` and `transfers.js`: shared
  browser operations, bounded request correlation and scoped file transfers.
- `treadway-preflight`: explicit Python/JavaScript/Robot structural checks; imports
  and constructors must be free of live effects. Structural success is not live acceptance.

Read [the boundary](BOUNDARY.md), [form capabilities and examples](docs/forms.md),
[shared widget APIs and React/Vue coverage](docs/REUSABLE-WIDGETS.md), and
[validation and remaining limits](docs/VALIDATION.md). Application-specific
adapters and result publication belong in consuming projects. There is no
mandatory service, model provider or second DSL.

The optional [Browser backend comparison](docs/BROWSER-COMPARISON.md) records
upstream reuse opportunities, measured local feedback and remaining parity gates.
