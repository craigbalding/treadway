# API index

Python modules live under `treadway`; CommonJS browser modules ship under
`treadway/browser`. [Installation](INSTALLING.md) covers their Node dependency.
Choose the task guide for a working example, or the reference for exact contracts.

## Browser operations

| API | Use | Details |
| --- | --- | --- |
| `FormAssessor`, `treadway.robot.FormLibrary` | Discover fields/actions, enter values and attempt one action | [Guide](forms.md) · [Reference](reference/FORMS.md) |
| `widgets.js`, `treadway.widgets.WidgetLibrary` | Autocomplete, multiselect, dates, notes and inline edits | [Guide](REUSABLE-WIDGETS.md) · [Reference](reference/WIDGETS.md) |
| `interactions.js`, `choices.js`, `prepared-edit.js` | Navigation, waits, controlled choices and guarded edits | [Recipes](../src/treadway/authoring/skill/treadway-flows/references/RECIPES.md) |
| `request-observer.js`, `transfers.js` | Correlate a response or transfer a scoped file | [Module contracts](reference/WIDGETS.md#public-modules) |

## Identities and authentication

| API | Use | Details |
| --- | --- | --- |
| `treadway.browsers.BrowserManager` | Own a Chrome process/profile and its exact target | [Lifecycle](../src/treadway/authoring/skill/treadway-flows/references/SESSION-REFERENCE.md#browser-lifecycle) |
| `treadway.sessions.HttpSession`, `actors.js` | Isolated cookies and same-session principal checks | [Session APIs](../src/treadway/authoring/skill/treadway-flows/references/SESSION-REFERENCE.md#actor-and-http-apis) |
| `state.js`, `targets.js` | Origin storage and scoped target observation | [State and targets](../src/treadway/authoring/skill/treadway-flows/references/SESSION-REFERENCE.md#scoped-state-and-target-observation) |
| `CredentialResolver`, `credentials_robot.CredentialLibrary` | Resolve named references and wrap Robot secrets | [Setup](CREDENTIALS.md) · [Providers](../src/treadway/authoring/skill/treadway-flows/references/CREDENTIAL-PROVIDERS.md) |
| `entra_robot.EntraLibrary`, `entra.js` | Existing sessions, password, TOTP and enrollment | [Setup](ENTRA.md) · [Reference](../src/treadway/authoring/skill/treadway-flows/references/ENTRA-REFERENCE.md) |
| `cookies.js`, `HttpSession.import_browser_cookies` | Export/import complete supported app-cookie state | [Cookie import](../src/treadway/authoring/skill/treadway-flows/references/ENTRA-REFERENCE.md#identity-and-state-lifetimes) |
| `recovery.OperationExecutor`, `AuthenticationOwner` | Maintain authentication and reconcile mutations | [Guide](SESSION-RECOVERY.md) · [Callbacks and policy](../src/treadway/authoring/skill/treadway-flows/references/SESSION-RECOVERY-REFERENCE.md) |

## Execution and inspection

| API | Use | Details |
| --- | --- | --- |
| `process.run_json_process` | Bounded JSON subprocess with retained stderr and partial results | [Transport contract](reference/FORMS.md#robot-and-cli) |
| `properties.require_expected_fields` | Compare independently expected fields, retaining missing/unknown states | [Recipes](../src/treadway/authoring/skill/treadway-flows/references/RECIPES.md) |
| `diagnostics.RunDiagnostics`, `diagnostics_robot.DiagnosticsListener` | Events, statistics and optional change guards | [Guide](OBSERVABILITY.md) · [Reference](../src/treadway/authoring/skill/treadway-flows/references/DIAGNOSTICS-REFERENCE.md) |
| `optimisation.summarise_profile`, `compare_objective_runs` | Offline timing and objective evidence comparison | [Guide](FLOW-OPTIMISATION.md) · [Records](../src/treadway/authoring/skill/treadway-flows/references/OPTIMISATION-REFERENCE.md) |
| `treadway-preflight` | Structural Python/JS/Robot checks without live execution | [Fast checks](FAST-FEEDBACK.md) |
| `generations.GenerationStore`, `Source` | Capture and lease immutable development source | [Development runtimes](DEVELOPMENT.md) |
