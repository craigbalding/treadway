# What Treadway and your adapter each provide

Treadway supplies reusable execution mechanics for web automation and testing.
Your application adapter defines the work, the correct user and resource, and
the observations that establish completion.

| Treadway provides | Your adapter supplies |
| --- | --- |
| Form discovery, controlled input, widget operations and request observation | Selectors, exact option IDs, routes and payload mappings |
| Isolated browser profiles and HTTP jars | Login configuration and an actual-user probe |
| Checks before dependent actions and strict field comparisons | Current resource/revision checks and independently chosen expectations |
| Durable intent and explicit recovery for supported HTTP mutations | Supported authentication mechanisms, effect observers and replay permission |
| Progress, statistics, private evidence and cleanup mechanics | Required business evidence and application resource cleanup |

Flows use native Robot sequencing or ordinary Python/JavaScript. Treadway requires
no hosted service, model provider or second scheduler. The shipped workboard is
synthetic; a real integration keeps its credentials, application bindings and
private captures outside this repository.

## Execution rules

Check the actual user and current resource inside the operation that depends on
them. A page target or identity label is insufficient. Preserve deliberate input
and identity variations in permission tests so the intended request reaches the app.
Browser connections require an exact target; remote transport uses the configured
HTTP proxy without a direct fallback.

Treat a click receipt and HTTP response as observations. Use the application's
saved-state check to establish completion. A human-input checkpoint must wait for
actual input. A timeout stops observation and cannot undo an action already sent.
Reconcile uncertain effects before deciding on replay, and record cleanup separately.

Reuse known mappings without substituting old results for fresh observations.
Optimisation must preserve the operator's requested result, or the specific
behaviour under test. See [authoring](docs/AUTHORING.md),
[API references](docs/API.md) and [validation history](docs/VALIDATION.md).
