# API index

Python modules live under `treadway`; browser JavaScript assets ship in
`treadway/browser`. [Installation](INSTALLING.md) covers their runtime dependency.

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


See [forms](forms.md), [widgets](REUSABLE-WIDGETS.md) and
[browser sessions](BROWSER-SESSIONS.md) for usage and coverage.
