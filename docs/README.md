# Treadway documentation

New to Treadway? [Run the local example](../README.md#try-the-local-example), then
follow [a walkthrough](EXAMPLES.md). For an installed wheel, guides are also
available through `treadway guide TOPIC`.

## Do a task

| Task | Guide | Installed topic |
| --- | --- | --- |
| Install a wheel or checkout | [Installation](INSTALLING.md) | `start` includes wheel setup |
| Write or extend a flow | [Authoring](AUTHORING.md) | `start` |
| Learn from working scenarios | [Examples](EXAMPLES.md) | `walkthrough` |
| Reuse a browser operation | [Forms](forms.md), [widgets](REUSABLE-WIDGETS.md) | `recipes` |
| Use distinct users or persistent profiles | [Sessions](BROWSER-SESSIONS.md) | `sessions` |
| Use remote browsers with live state recovery | [Browserserve (recommended)](BROWSERSERVE.md) · [Providers](REMOTE-BROWSERS.md) | `browserserve` · `remote` |
| Read credentials from a configured source | [Credentials](CREDENTIALS.md) | `credentials` |
| Sign in through Entra | [Entra](ENTRA.md) | `entra` |
| Renew a session during repeat work | [Session recovery](SESSION-RECOVERY.md) | `recovery` |
| Diagnose a failure or show progress | [Logs and screenshots](OBSERVABILITY.md) | `diagnostics` |
| Remove unnecessary steps from a flow | [Optimisation](FLOW-OPTIMISATION.md) | `optimisation` |

## Look up an API or constraint

- [API index](API.md) routes to modules and detailed references.
- [Project scope](../BOUNDARY.md) separates shared mechanics from application rules.
- [Form API](reference/FORMS.md) and [widget API](reference/WIDGETS.md) describe mappings and receipts.
- [Shared development runtimes](DEVELOPMENT.md) covers immutable source generations.

Each task guide links to the relevant configuration and recovery details.

## Contribute or investigate the design

- [Fast checks](FAST-FEEDBACK.md) and [CI and releases](RELEASING.md).
- [Flow optimisation design](FLOW-OPTIMISATION-DESIGN.md).
- [Proposed Browserless support](BROWSERLESS-DESIGN.md), including concurrent projects.
- [Browser backend evaluation](BROWSER-COMPARISON.md) and [reproduce the experiment](../experiments/browser-comparison/README.md).
- [Validation history](VALIDATION.md) and [original authoring-kit trial](AUTHORING-VALIDATION.md).

Validation records retain the results and limits of dated runs. Use the current
API guides and CI for today's behaviour and check commands.
