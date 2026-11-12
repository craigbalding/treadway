# Browser reuse comparison

Decision: pursue **Robot Framework Browser as an optional execution backend**,
while retaining Treadway's operation contracts and actor/resource safeguards.
The tested subset works on real React, Vue and Element Plus fixtures. This is
enough evidence for a staged integration, not enough to remove the current
backend or promise broad component-kit compatibility.

The [reproducible experiment](../experiments/browser-comparison/README.md) uses
Browser 21.0.0, Playwright 1.64.1, Robot 7.5.1 and the same sandboxed Chromium
headless shell on both sides. Production Python/Node dependencies and runtime
APIs are unchanged. The only shared test-harness change lets a caller start the
existing widget server without also launching Chrome, and optionally serve the
real component kit.

## Evidence and measurements

The final quiet matrix on 2026-11-10 passed **18/18 runs and 306/306 recorded
checks**: three repetitions of each backend/framework combination, alternating
backend order. Five additional integration checks passed. A separate default
behavior check confirmed the dialog incompatibility described below. The final
audit verified 38 source/dependency-file hashes against the current checkout and
the exact Chromium executable hash. Production runtime code is unchanged.

Median complete scenario times, with observed minimum–maximum in parentheses:

| Fixture | Current Treadway | Browser candidate |
| --- | ---: | ---: |
| React 18.3.1 | 19.05s (17.61–19.06) | 11.79s (11.60–14.60) |
| Vue 3.5.45 | 16.28s (15.56–16.58) | 12.00s (11.19–12.77) |
| Element Plus 2.14.8 on Vue | 21.35s (21.14–22.58) | 17.08s (15.94–18.94) |

These times include startup, the guarded widget scenarios, three actor sessions,
authorization cases, observations and cleanup. They are local implementation
measurements on one Linux sandbox, not a general engine benchmark or a promise
for external sites. The full 18-run measurement matrix takes several minutes;
one selected scenario is the development feedback loop.

The main savings come from widget execution and additional session setup:

| Median portion | React: current / Browser | Vue: current / Browser | Element Plus: current / Browser |
| --- | ---: | ---: | ---: |
| Six widget checks, including navigation and guarded refusals | 7.88s / 4.21s | 7.55s / 3.66s | 9.79s / 6.52s |
| Two additional actor sessions with mounted pages | 4.77s / 1.62s | 4.24s / 1.55s | 6.30s / 2.83s |

Browser is not faster for every part. Session startup medians were 4.89–6.64s,
versus 1.95–3.02s for the current path. Native JavaScript libraries are already
loaded before that timer, whereas Browser imports and Node/gRPC initialization
are included: these are session startup paths, not symmetrical cold library
starts. Fresh stale-revision refusal medians were 34.5–48.1ms for current Treadway
and 66.7–90.4ms for Browser, including actor selection and fresh application reads.

Source hashes, exact launch arguments, process/profile observations, per-check
timings and independent server evidence are retained in
`artifacts/browser-comparison-2026-11-10T00-53-05-765Z-f4cecd/`. Integration evidence
is in `artifacts/browser-integration-1794271892530/` and default behavior evidence
in `artifacts/browser-defaults-1794271939426/`. These local captures are ignored;
the experiment and measurements above are self-contained and reproducible.

The frontier QA review found and prompted fixes for bounded worker shutdown,
spawn failure, cleanup of every owned process/profile, cleanup chaining after
failure, process identity validation and the startup timing label. The final
read-through found no remaining material issues in this scope. The integration
suite reproduces a blocked worker and checks that forced shutdown stays bounded
and remains reported as unconfirmed cleanup/effects. Existing core checks also
passed: 62 Node contracts and all three fast browser checks, with no skips.

The matching scenarios establish delayed-query readiness, actual option IDs,
controlled values surviving rerender, actual HTTP response/body observation,
and independently observed server-received values. Changed targets, replaced
fields/actions, wrong IDs, wrong principals and stale revisions refuse before
the relevant operation. Domain guards are shared application code, not Browser
features. The synthetic resource state is in-memory, not durable storage.

Three actor sessions (Alice, Bob and anonymous) retain separate cookies/local
storage/session storage, with actual principals checked from the application.
Alice → Bob → Alice writes target the same resource,
with handoffs and current revisions. Explicit self-approval and private-ID
requests still reach the application and receive actual refusals. These
negative attempts are intentionally separate from operations whose prerequisite
requires a particular principal.

Additional integration checks run real `.robot` tests on all three fixtures:
standard Browser keywords drive the component, the guarded extension refuses a
changed target, and native Robot stops the following keyword. Browser also
attaches to a Treadway-owned Chrome instance, selects the exact CDP target among
two tabs, and detaches while leaving the owned browser usable.

## Where to reuse upstream code

| Treadway area | Evidence and next action |
| --- | --- |
| Navigation, ordinary input/clicks and element waiting in `interactions.js` / form execution | Highest priority for upstream reuse. Browser operates the tested controlled React/Vue inputs and real remote select. Add a backend boundary behind existing operation contracts. |
| Browser processes and actor sessions | Browser contexts substantially reduce process count: one browser for three sessions instead of three owned browser profiles. Treat this as an explicit isolation choice. Existing process ownership, profile retention and lifecycle policies still need integration. |
| `choices.js`, `prepared-edit.js`, widget profiles | Preserve exact-ID, retained-reference, native-target, readback and fresh domain-guard contracts. Standard locators alone do not establish them. The experiment's extension implements only the subset exercised here. |
| Raw CDP transport | Browser can attach and Playwright can create a CDP session. This opens a route to reuse transport without immediately rewriting all specialized operations. Deadline, scoped event, lease and generation behavior still need parity checks. |
| Request observation | Basic response/body correlation works. Keep incomplete-effect/body limits and exact request-count contracts until interrupted/redirected/worker cases are covered. |
| Diagnostics | Upstream traces, screenshots and browser/network inspection are useful batteries. This comparison does not prove complete evidence-policy or secret-redaction compatibility. |
| Application adapters | Keep actual principal/resource/revision checks and independent effect observers. Neither a framework name nor a library success replaces these. |

## Defaults and remaining gates

Browser supports `New Browser    chromiumSandbox=${True}`; its default is false.
The trial enables it explicitly and observes the actual launch command without
`--no-sandbox`, plus private profile permissions. It does not weaken the sandbox
or patch upstream. Browser contexts isolate session state; they do not provide
separate operating-system browser processes.

One measured default conflicts with Treadway's contract: an unhandled JavaScript
confirmation is automatically dismissed by Browser/Playwright and execution
continues. Treadway retains the dialog and stops. Before a production backend
can be enabled, it must establish explicit dialog handling before scripts run,
including newly opened pages. Accepting this upstream default would change the
flow's chosen stimulus.

Other gates include exact session/target lease integration, launch flags and
profile policy, complete failure/evidence semantics, deliberate download/dialog
choices, secret logging and installed-package behavior. Remaining widget tests
include multiselect, real datepicker popups, rich-text editing and frame/worker
boundaries. The small experimental adapter is not a replacement for those tests.

Browser's defaults and locator conveniences are configurable tools, not an
authorization or concurrency oracle. Retained handles prevent the tested silent
selector replacement, but neither adapter makes guard observation and later
dispatch atomic. Applications must still enforce their own current state.

The next implementation should introduce the optional backend for ordinary
input, waiting and the calibrated select, preferably with an existing owned
browser attachment path. Extend the existing tests for changed state and failed
prerequisites to both backends before deleting each corresponding mechanism. Keep
the current backend available until the broader parity gates pass. The likely benefit is less custom
browser machinery and better diagnostics; this experiment deletes no production
code and makes no quantified maintenance-saving claim.

## Primary references

- [Browser keyword reference](https://robotframework-browser.org/keywords/)
- [Browser context model](https://robotframework-browser.org/docs/concepts/browser-context-page/)
- [Supported JavaScript extensions](https://robotframework-browser.org/docs/extending/javascript-extensions/)
- [Playwright locator behavior](https://playwright.dev/docs/locators)
- [Element Plus select](https://element-plus.org/en-US/component/select.html)
