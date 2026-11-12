# Validation and operating limits

The checks use synthetic local fixtures, loopback servers and an isolated browser.
They establish the covered mechanics, not a particular application's behavior.

## Checks

Run from the project root after installing the development dependencies:

```sh
python -m pytest -q
npm test
ruff check src tests --config src/treadway/robot-ruff.toml
CHROME_BIN=/absolute/path/to/chromium \
  FORM_REACT_FIXTURE_ROOT="$PWD" FORM_ROBOT_PYTHON="$PWD/.venv/bin/python" \
  npm run test:browser
```

Run these stages serially. The subprocess tests include short deadlines and may
be sensitive to scheduling under concurrent load. Earlier concurrent runs missed
expected initial output in two 0.3-second process fixtures; the precise cause was
not isolated. Serial runs passed. This remains a test robustness limitation.

The browser checks cover React controlled fields, readback after another render,
explicit checkbox and custom-choice selection, validation feedback, responses
that do not establish business completion, stale contexts, dialogs, attempt memory
and actual Robot composition. A failed preparation must stop subsequent keywords,
including when the scenario author omits a separate boolean assertion.

The optional browser suite skips when its prerequisites are unavailable. Skips
must remain visible and do not establish calibrated browser support.

## Checked baseline

The initial project baseline was checked on 2026-11-06 with Python 3.13.5,
Node 22.23.2, Robot Framework 7.5.1 and React 18.3.1:

- Python: 58 tests passed.
- Node: 23 tests passed.
- Ruff and the example Robot dry-run passed.
- Chromium/React: all 17 child cases plus the parent passed, with no skips.
- The same browser suite passed from outside the checkout against a separately
  installed wheel, including the actual Robot success and failure paths.
- The wheel contains only the shared package and its distribution metadata.

The dry-run establishes structure only; its example target value is not a live
browser binding. Application-specific calibration remains the caller's responsibility.

## Installed package

Build a wheel and install it in a separate virtual environment. Install its Node
runtime as described in the README. Run the browser checks from outside the
checkout, setting `FORM_BROWSER_MODULE_ROOT` to the installed `treadway/browser`
directory and `FORM_ROBOT_PYTHON` to the separate environment's interpreter.
`FORM_REACT_FIXTURE_ROOT` supplies the local React development fixture dependencies.
This exercises both installed implementations without a `PYTHONPATH` workaround.

## Limits

- Application adapters must verify the intended account, resource and current
  application state using suitable observers. A form action remains
  completion-unconfirmed; HTTP status and network idle do not prove persistence.
- Form coverage is main-document DOM and explicitly selected same-origin iframe
  documents with the tested interaction patterns. Cross-origin/nested/transformed
  frames, shadow roots, uploads, downloads, multi-selects and arbitrary component
  libraries require further calibration. Low-level CDP methods do not provide
  the form layer's journaling and context checks.
- Native dialog observation starts at attachment. An already-open dialog can
  prevent initialization. Manual challenges require application-owned checkpoints.
- Field redaction is heuristic. Labels, feedback, choices, logs and ordinary field
  values can contain private data; Robot can also log keyword arguments and returns.
  Use restricted journals/output and keep private inputs out of these keywords.
- The CLI flushes intent before dispatch. Programmatic callers own durability of
  their record callback. Interrupted execution or a lost response preserves
  uncertain effects and does not justify an automatic retry.
- Process-group cleanup is tested on POSIX. Detached groups and descendant cleanup
  on other platforms are outside the current contract. Progress callbacks must
  be bounded; callers own input/output size limits and artifact retention.
- Browser assets require Node and the explicit runtime dependency installation.
  Remote browser transport supports plain HTTP CONNECT proxies without a direct
  remote fallback. A page target alone does not verify the signed-in account.

## Selector binding and inline Enter (2026-11-06)

Added exact selector-to-observed-control binding and an explicit, journaled Enter
intent for ordinary inline text inputs. The Robot facade exposes selector binding.
Focused checks: 20 Python result/transport checks, 23 Node checks, and all 19 real
Chromium/React child cases plus their parent passed with no skips. The browser
suite also passed against a fresh wheel installed outside the checkout, including
actual Robot composition. A first transport-test run under concurrent image I/O
missed output before its 0.3-second deadline; the focused rerun passed. The existing
scheduling sensitivity described above remains; assertions were not changed.

## Focusable row calibration (2026-11-06)

Treadway now inventories native/ARIA focusable table rows as unverified actions
and retains controls, expansion and selection attributes. The local fixture
covers row actions that are not buttons. All 20 real-browser
child checks plus parent passed, both in the checkout and against a separately
installed wheel, including actual Robot composition. The locator also reports
its observed match count when refusing an ambiguous/missing selector.

## Explicit iframe and editable-host calibration (2026-11-07)

`treadway.form/2` adds explicit same-origin iframe bindings and deliberate plain-text
input to editable hosts. The six new real-browser child cases plus parent passed,
including actual Robot calls across separate CLI invocations. The prior 20 browser
child cases plus parent also passed. All 28 checks passed without skips against a
fresh wheel in a separate environment, with both Node assets and Robot imported
from the installation. The fixture uses offset/bordered frames, React state under
CSP, a real server-side POST, literal markup-like text, frame replacement, parent
dialogs, and refusals for missing/ambiguous/cross-origin frame selectors.

An initial coordinate-order defect caused selection outside the intended host;
the selection guard stopped before deletion. Measuring the parent frame after
the child's scroll preparation corrected it. The local iframe cases cover the
selection and context guards; they do not establish universal editor support.

## Alert feedback classification (2026-11-07)

A success notice exposed that an ARIA alert does not necessarily mean
validation failure. The observer now records the feedback source and reserves
validation diagnosis for invalid fields or an explicit component error marker.
An unclassified alert remains page feedback with completion unconfirmed. All 29
browser checks passed without skips in the checkout and against a rebuilt wheel,
including the new real-browser success-alert regression and both Robot fixtures.

## Independent execution-integrity QA (2026-11-07)

Two new synthetic Chromium cases reproduced false preparation success: a native
select inside an iframe could change through an opaque parent overlay, and an
editable field could change the parent route while returning a reusable complete
preparation. Native selects now use the same parent hit test as pointer input.
Each input and the final observation must retain the original document, route,
step and frame binding, with new dialogs blocking preparation. Incomplete results
retain entered-value receipts and the final observation; they do not claim that
earlier input was undone.

Checks: 59 Python tests, 23 Node tests and Ruff passed. The full real-browser suite
passed all 32 checks (30 child cases and two parents), without skips, both in the
checkout and against a fresh wheel installed outside it. The new cases include
unobscured select success, obscured select refusal, route-change refusal, and an
actual Robot scenario that cannot execute its following keyword after the route
changes during input. Existing success-alert feedback and Robot success paths
also passed.

The wheel was built with `uv build --offline`, installed with its Robot extra in
`/tmp/treadway-frontier-installed`, and given its locked Node dependency using
`npm ci --offline --ignore-scripts` in the installed browser directory. Both the
Python import and Node's `ws` resolution pointed inside that installation. Browser
logs are retained in `artifacts/frontier-qa-2026-11-07/`. All browser fixtures were
new isolated local processes; this pass did not access application environments.

## Controlled wrapper choices and query focus (2026-11-07)

`treadway.form/3` observes explicit `aria-controls` relationships through a unique
controlled element containing a visible listbox. It also retains the existing
direct-listbox-ID path. Fields expose target match counts and related listbox
references; listboxes expose their controller references. Selection requires one
unambiguous relationship, the same relationship in the supplied and refreshed
snapshots, and a usable field/list/option. Pointer preparation checks the DOM
relationship again before input. Duplicate IDs, unrelated lists and hidden or
disabled options cannot supply a fallback choice. The new runtime key invalidates
references produced by the earlier protocol; inspect again after upgrading.

A synthetic autocomplete that clears its query on blur reproduced a failed
readback before the focus correction. Explicit combobox `type_query` now retains
focus for a separately chosen observed option. Ordinary fields still tab out.
The passing regression checks retained query text, zero query blurs, a trusted
explicit choice, and ordinary-field blur. Query readback remains distinct from
selection or persisted application state.

All 52 real-browser checks passed without skips both in the checkout and against
a fresh wheel installed outside it. Coverage includes the existing React direct-ID
choice, controlled wrappers, stale relations with surviving DOM nodes, duplicate
and missing IDs, multiple related lists/controller paths, unrelated lists, hidden
and disabled choices/fields, and a change immediately before pointer preparation.
Actual Robot calls select a wrapper option across CLI invocations and stop the
following keyword when duplicate IDs prevent selection. The previous Robot/frame
checks also passed. The fixture models DOM behavior; it does not certify an
arbitrary component framework or a live application's business outcome.

The 23 Node checks and Ruff passed. All 59 Python checks passed in separate
10-test transport and 49-test remaining groups. Two all-in-one Python invocations
hit the previously documented 0.3-second descendant-pipe fixture sensitivity:
the initial JSON was unavailable at the deadline. That test passed in isolation
and in the complete transport module. No transport code, assertion or deadline
was changed; the precise scheduling cause remains unisolated.

Built using `uv build --offline`, the final wheel was installed with its Robot
extra into `/tmp/treadway-choice-final-installed`; its Node runtime was installed
using `npm ci --offline --ignore-scripts`. Python and `ws` resolved inside that
installation, and both changed browser assets matched the checkout byte-for-byte.
Browser logs and the failing pre-fix blur regression are retained under
`artifacts/choice-calibration-2026-11-07/`.

## Explicit ownership relationships (2026-11-09)

A textarea combobox can associate its list through `aria-owns`. Protocol `treadway.form/4` observes both ownership and control
ID relationships with the same unique-target, visible-listbox and refreshed
pointer guards. Identical IDs across the attributes are deduplicated; a missing
owned target or conflicting controller paths refuse selection. No application
selector or visible-popup fallback was added to the shared library.

The full browser suite passed 56/56 without skips in the checkout and again
against a fresh wheel in `/tmp/treadway-owns-installed`. Both runs included real
Robot composition. The wheel and its locked Node runtime were built/installed
offline; `FORM_BROWSER_MODULE_ROOT` and `FORM_ROBOT_PYTHON` selected the installed
package. Core logs are retained locally under
`artifacts/widget-calibration-2026-11-09/core-owns-full-browser.log` and
`core-owns-installed-browser.log`.

The existing 0.3-second Python transport tests exhibited their previously
recorded scheduling sensitivity during concurrent application startup. The
complete transport module passed separately, 10/10. Final idle verification then
passed all **59 Python tests** in one invocation without changing assertions or
deadlines, recorded in the same local archive as
`core-owns-python-final-idle.log`. The 23 Node checks also passed.

## Reusable widget profiles and fast feedback — 2026-11-09

[Reusable widgets](REUSABLE-WIDGETS.md) documents the shared interaction, choice,
prepared-edit, request and transfer APIs plus five profiles and native Robot
keywords. Core passes **54 Node / 64 Python** tests and configured Ruff. Both
checkout and installed wheel cover **98 distinct browser cases** without skips:
the unchanged 56-case baseline within the prior complete 96-case runs, followed
by the affected updated 42-case profile group in each environment. Those current
profile cases include real React/Vue state, portals, deterministic query-response
release, actual Robot composition and blocked subsequent steps. Runtime assets
match the installed package bytes.

Core-only reports and the source-byte audit are retained under
`artifacts/widget-calibration-2026-11-09/`. The
[fast-feedback guide](FAST-FEEDBACK.md) provides this repository's focused contract,
framework smoke and complete browser commands. Consumer acceptance and runtime
lifecycle observations are maintained by the consuming project; they are not
prerequisites for running or verifying this library.

## Installable authoring kit — 2026-11-09

The wheel now includes the `treadway` authoring command, `treadway-flows` skill,
standalone guide/recipe index and complete local reference project. See
[the authoring validation ledger](AUTHORING-VALIDATION.md) for exact installed
package, timing, fault and independent fresh-flow evidence. This adds an agent
entry point and examples without changing the shared browser mechanics.

## Standalone public guidance and walkthroughs — 2026-11-09

Public setup, API and validation instructions now resolve within this repository.
Generic adapter-design guidance covers actor/resource bindings, independent effect
observers, reusable checkpoints and deliberate variations in the packaged
authoring guide. [Fast feedback](FAST-FEEDBACK.md) documents core-owned checks.
Application-specific lifecycle and acceptance records remain with their consumers.

[The guided examples](EXAMPLES.md) walk humans and agents through the shipped
create/schedule, same-item handoff and competing-revision scenarios.
`treadway guide walkthrough` prints the same guide from an installed package.
All eight authoring tests passed, including guide routing and skill export.
A rebuilt wheel exported a fresh standalone project; all three browser scenarios
and local checks passed in **34.205 seconds**, with zero remaining items.
Core API and browser mechanics were unchanged by this documentation update.

The public-source and wheel audit found no private-repository references or
links outside the checkout. Project-template links were checked in their exported
context. The wheel contains the walkthrough and excludes raw artifacts and
application integrations. Core calibration logs are retained in the ignored
`artifacts/widget-calibration-2026-11-09/`; the boundary audit and fresh installed
example reports are under `artifacts/public-docs-boundary/`. These private local
run records are optional evidence, not a prerequisite for public instructions.

## Owned browser lifecycle and collaborative sessions — 2026-11-09

[Browser sessions](BROWSER-SESSIONS.md) documents the shared Chromium launcher,
exact CDP targets, isolated profiles/cookie jars, actual-principal checks,
origin-state observations and target-scoped capture. The shipped collaboration
walkthrough submits actual self-approval and cross-user private-resource attempts,
requires application refusals and observes persisted effects independently.

Final checks passed **83 Python** tests in 53.47 seconds and **62 Node** contracts
in 2.45 seconds, plus configured Ruff and skill validation. A fresh installed
wheel passed **99 browser cases** without skips in 182.05 seconds and **9 focused
Python lifecycle/HTTP checks** in 17.50 seconds. Sandboxing remained enabled.
The installed standalone project's five Robot cases passed in **66.80 seconds**
overall with an explicit 120-second budget; browser execution took 60.21 seconds.
Scoped cleanup left zero workboard items and complete owned-browser cleanup.
The separate deadline regression verifies cleanup after forcibly stopping Robot.

Independent frontier QA identified five issues, now fixed and re-reviewed:
detached-session disposal, capture disconnect termination, interpreter selection,
actor-browser cleanup after timeout and slow-response-header deadlines. No
material findings remain. Source/wheel audits found no private-repository
references; packaged assets match source bytes and local documentation links
resolve. Core-only logs and byte fingerprints are retained locally under
`artifacts/browser-sessions-20261109/`.

These checks use synthetic loopback applications. Lifecycle support is currently
Linux; origin clearing has documented cookie/cache limits. HTTP response progress
has a deadline, while DNS/connection establishment retains standard-library
limitations. A timeout preserves uncertain application effects; successful browser
cleanup does not establish application rollback.

## Named credentials and optional vault providers — 2026-11-09

[Credentials](CREDENTIALS.md) documents reference-only identity configuration,
the standard-library provider interface and native Robot `Secret` values.
Environment, 1Password CLI, optional RPA Vault and already-authorized SafeYolo
gateway providers are explicit and separate from login/session renewal.
The collaboration walkthrough now resolves credentials through this boundary,
uses a typed application login keyword and retains only a login receipt.

The final complete Python run passed **101 tests**, with one optional RPA test
skipped in the core development environment, in **67.65 seconds**. In the fresh
wheel installation with the actual optional RPA 34.0.1 dependency, all **18
credential/Robot tests** passed in **24.51 seconds**, including that real file
adapter. All **62 Node contracts** passed. The three fast browser checks passed
against installed assets without skips in **25.96 seconds**. The installed
standalone project's five Robot walkthrough cases passed in **66.18 seconds**
overall with an explicit 120-second budget; the browser command took 56.16 seconds.

Independent frontier QA found and verified remediation of one material issue:
universal-newline subprocess decoding changed CRLF and bare CR in 1Password
values. An opt-in UTF-8/newline-preserving transport mode now retains exact text;
the default JSON transport behavior is unchanged. The reviewer independently
checked Unicode/line endings, actual RPA retrieval and Robot TRACE canaries, and
ran the collaboration walkthrough at both normal and TRACE logging. No material
findings remain. Password canaries were absent from reports and actor journals.

A separately installed base wheel proved usable without Robot or RPA imports.
Wheel assets match source and installed bytes; exported documentation links
resolve. The pre-existing 0.3-second descendant-pipe test missed its initial JSON
during some concurrent checks; the final complete Python run passed without
changing that assertion or deadline. Core logs, byte fingerprints and the QA
record are retained privately under `artifacts/credentials-20261109/`.

All data was synthetic. Hosted vault authentication, real 1Password authorization
and live SafeYolo grants were not exercised. RPA file mode is plaintext storage;
Robot's wrapper is log protection, not encryption or a universal redactor.
SafeYolo's adapter reads an existing scoped gateway token, never a host vault or
admin credential, and does not request access. Real provider authorization and
application login remain explicit consumer operations.

## Browser reuse comparison — 2026-11-10

The optional [Browser comparison](BROWSER-COMPARISON.md) is an executable local
experiment, not a production backend migration. It uses the existing React/Vue
fixtures and one actual pinned Element Plus remote select. Production dependencies
and shipped assets are unchanged; the shared test fixture can now serve a site
without automatically launching a browser, and accept experiment-owned assets.

The final quiet matrix passed 18/18 combinations and 306/306 recorded checks,
three rounds per backend/framework pairing. The same Chromium 156.0.8078.4
headless shell, sandbox enabled and 1280×720 viewport were used on both sides.
The audit verified all 38 recorded source/dependency-file hashes and the browser
binary hash against current bytes. All observed actor processes/profiles were
checked during teardown. Median full scenario times were 19.05/11.79s for
current/Browser React, 16.28/12.00s for Vue and 21.35/17.08s for Element Plus.
Startup measurement asymmetry and sample ranges are disclosed in the comparison.

Five separate integration checks passed: native Robot positive/expected-failure
composition on all three fixtures, exact CDP attachment among two owned tabs
with continued browser usability after detach, and missing-interpreter/blocked
worker failure handling. Each Robot negative test deliberately remains FAIL;
the harness verifies the precise guard failure, no following keyword effect and
no unintended save. Forced worker cleanup remains an explicitly unconfirmed
outcome, never converted into ordinary successful cleanup.

A separate check confirms that Browser's default unhandled-dialog dismissal
conflicts with Treadway's explicit-choice policy. This is a production integration
gate. The frontier reviewer found issues in lifecycle failure handling, cleanup
evidence and the startup label; fixes were implemented and re-reviewed with no
remaining material findings. The focused blocked-worker regression and complete
integration rerun passed after remediation. Existing checks passed as well:
62 Node contracts and 3/3 fast browser checks, with no skips.

The current-source matrix and completion audit are retained under
`artifacts/browser-comparison-2026-11-10T00-53-05-765Z-f4cecd/`; final integrations
under `artifacts/browser-integration-1794271892530/`; dialog evidence under
`artifacts/browser-defaults-1794271939426/`. Earlier failed/exploratory evidence is
retained separately and does not establish the final timing results. The tests
use synthetic in-memory server state, not durable database persistence or live
applications. Multiselect, rich editors, real datepickers, frames/workers, transfers,
interrupted observation, session leases and secret logging remain outside this
backend comparison's demonstrated parity.
