# Execution evidence

Use Robot Framework's execution model, result files and log viewer. Treadway
supplies the observations needed to interpret a browser operation: current
identity and target bindings, screen state, intended action, dispatch receipt,
observed response, independent verification and cleanup. A runner's PASS or FAIL
cannot establish all those facts on its own.

## Existing facilities

| Facility | What it supplies | Remaining Treadway responsibility |
| --- | --- | --- |
| Robot Framework output JSON/XML and HTML log | Keyword hierarchy, timestamps, durations, status, failure messages and library log messages | Emit structured domain observations before failure; retain each attempt separately |
| Robot listener API | Immediate keyword, message and execution-result callbacks | Attach observations and artifact references to the relevant operation |
| Robot `ExecutionResult` and `ResultVisitor` | Supported access to recorded execution results | Produce a concise agent view without inventing causes or parsing HTML |
| Robot native `Secret` | Masked credential values at keyword boundaries | Keep resolved credentials, enrollment seeds, codes and cookies out of ordinary state captures and messages |
| Robot Framework Browser | Failure screenshots and Playwright tracing for its browser backend | Configure and retain artifacts; establish domain identity, action outcome and independent verification |
| Robocorp Log | Python call/variable logging, compact files, HTML viewer and sensitive-value controls | Explicit domain observations; coverage for Node/CDP operations |

Robot already supports JSON output in the pinned 7.5.1 environment. A local
synthetic check exercised a failed keyword followed by a separate successful
attempt: the native result API retained structured observations, failure text
and timings, listener callbacks saw the failure, and a native `Secret` remained
masked even at TRACE level. This does not establish arbitrary snapshot redaction;
browser state still requires its own credential handling.

Browser's default failure action takes a screenshot. Its documentation states
that this hook is not applied to library methods called directly from Python.
Adding it beside a different browser transport does not automatically give that
transport the same failure evidence. Screenshots and traces can also contain
credentials and private application data.

The shared Entra flow captures private screenshots at observed step boundaries
and on failure. Masking is optional and defaults to `none`; the explicit
`credentials` mode masks fields and known secrets, including full setup screens.
This is separate from structured-log redaction, which remains enabled. See the
[Entra guide](ENTRA.md) for configuration and result fields.

Robocorp Log is useful for Python diagnostics, but its documented log format is
not a stable API. Its README also documents limitations with coroutine logging.
These make it unsuitable as the sole machine-readable contract for an async
Node browser integration. Its default rotating-file policy also needs explicit
configuration when earlier attempt evidence must survive.

## Integration contract

1. Allocate a private, unique output directory before executing an attempt.
   A successful retry gets a new directory and retains the failed attempt.
2. Use Robot's native outputs for execution reports and result analysis. Emit
   structured observations through its logging API and link private artifacts.
3. Capture the last screen, expected transition, elapsed and remaining time,
   underlying error category, actions dispatched and uncertain outcomes before
   returning a failure. A timeout is an observation boundary; it does not cancel
   an already-dispatched browser action.
4. Retain in-progress browser observations when running outside Robot or when a
   subprocess might terminate before its final result. This is a small durability
   adapter, rather than another execution model or report viewer.
5. Make the concise receipt an index into the retained evidence. Keep observed
   facts, expected values and hypotheses distinct. Do not label a failure as
   identity-specific or infer an infrastructure cause from a stage timeout.
6. Keep authentication verification, required state export, runner completion and
   cleanup separate. A valid principal probe does not prove that an exported
   cookie jar is complete; a partial subprocess payload does not prove that the
   runner completed. The same export contract applies to fresh and reused sessions.

## Primary references

- [Robot execution artifacts and logging](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#execution-artifacts)
- [Robot listener interface](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#listener-interface)
- [Robot result model](https://docs.robotframework.org/docs/parsing_results)
- [Browser keyword documentation](https://marketsquare.github.io/robotframework-browser/Browser.html#Register%20Keyword%20To%20Run%20On%20Failure)
- [Robocorp Log capabilities and caveats](https://github.com/robocorp/robocorp/blob/master/log/README.md)
- [Robocorp output retention configuration](https://github.com/robocorp/robocorp/blob/master/tasks/docs/guides/01-output-customization.md)
