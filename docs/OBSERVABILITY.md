# Screenshots and execution logs

The shared Entra sign-in flow saves step screenshots and a record of each
attempt. For other flows, you can enable live progress and run statistics from
Python or Robot. Robot also provides its usual keyword logs and HTML reports.

## Screenshots

The Entra flow saves screenshots during successful and failed attempts. It
takes a screenshot when it observes a new step or the result of an action, and
tries to capture the last screen before returning a failure. Other flow adapters
must arrange their own screenshot capture; enabling `RunDiagnostics` alone does
not add screenshots.

Open the directory named by `evidence.directory` in the Entra browser result:

- `receipt.json` contains the final result and its suggested next step.
- `events.jsonl` records screens, actions and screenshot captures in order.
- `step-*.png` files show the captured screens.

The result's `screenshots` list records each capture's status. A `captured`
entry includes its file path, size and elapsed time. If the page changed during
capture, the status is `screen_changed` and the image is discarded. Check this
list when an expected image is missing.

If setup failed before the browser flow started, the Robot result's
`robotEvidence` path points to the setup receipt.

Screenshot masking is optional and defaults to `none`. Choose `credentials`
to mask input values and known secrets; during authenticator setup, this mode
hides the whole enrollment screen. Structured diagnostic events exclude secret
values independently of this setting. Keep screenshots and raw browser records
private: they can contain account details, setup codes and application data.

See the [Entra guide](ENTRA.md) for configuration and result fields.

## Live progress and run statistics

To try diagnostics with a complete local example:

```sh
treadway new my-flow
cd my-flow
python debug_recovery.py --level DEBUG
```

The example runs 100 mutations against a disposable local app. It renews an
expired session and checks a committed write whose reply was lost. Progress
goes to stderr; the final result and statistics go to stdout. A private run
directory holds `events.jsonl`, `summary.json` and `coverage.json`. Use
`--no-console` to retain these files without printing progress.

For your own Python flow, wrap execution in `RunDiagnostics`. For a Robot suite,
use `DiagnosticsListener` to send events to the terminal and Robot's normal log.
The [diagnostics guide](../src/treadway/authoring/skill/treadway-flows/references/DIAGNOSTICS.md)
has both configurations, custom output callbacks, timing details and checks for
changes to flow code. It also ships with the package:

```sh
treadway guide diagnostics
```

## Investigating a failed attempt

Read the result first, then follow its artifact paths. Compare the last observed
screen with the action and response recorded in the event log. A timeout means
Treadway stopped waiting; the application may still have accepted the action.
Check the saved application state before deciding whether to retry a mutation.

Keep the failed attempt when a later attempt succeeds. The Entra flow gives each
attempt its own private directory so a retry cannot overwrite the first failure.
Custom adapters should do the same.

Check login, state export and cleanup separately. For example, an Entra result
can confirm that the correct user is signed in while reporting that cookie
export failed. Preserve that session and retry the export, rather than logging
in again. A cleanup failure likewise does not undo a successful action.

## Robot and related tools

Robot's reports show which keywords ran and how long they took. The application
checks in your flow establish whether the intended work succeeded. Use both when
interpreting a result.

| Facility | What it supplies | Remaining Treadway responsibility |
| --- | --- | --- |
| Robot Framework output JSON/XML and HTML log | Keyword hierarchy, timestamps, durations, status, failure messages and library log messages | Emit structured domain observations before failure; retain each attempt separately |
| Robot listener API | Immediate keyword, message and execution-result callbacks | Attach observations and artifact references to the relevant operation |
| Robot `ExecutionResult` and `ResultVisitor` | Supported access to recorded execution results | Produce a concise agent view without inventing causes or parsing HTML |
| Robot native `Secret` | Masked credential values at keyword boundaries | Keep resolved credentials, enrollment seeds, codes and cookies out of ordinary state captures and messages |
| Robot Framework Browser | Failure screenshots and Playwright tracing for its browser backend | Configure and retain artifacts; establish domain identity, action outcome and independent verification |
| Robocorp Log | Python call/variable logging, compact files, HTML viewer and sensitive-value controls | Explicit domain observations; coverage for Node/CDP operations |

## Primary references

- [Robot execution artifacts and logging](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#execution-artifacts)
- [Robot listener interface](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#listener-interface)
- [Robot result model](https://docs.robotframework.org/docs/parsing_results)
- [Browser keyword documentation](https://marketsquare.github.io/robotframework-browser/Browser.html#Register%20Keyword%20To%20Run%20On%20Failure)
- [Robocorp Log capabilities and caveats](https://github.com/robocorp/robocorp/blob/master/log/README.md)
- [Robocorp output retention configuration](https://github.com/robocorp/robocorp/blob/master/tasks/docs/guides/01-output-customization.md)
