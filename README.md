# Treadway

**High-assurance web workflows for humans and agents.**

Treadway helps people and agents carry out work in web applications with explicit
intent, checked prerequisites and evidence of the outcome. Compose browser and
HTTP operations into workflows that use the intended identity, protect current
resource bindings and verify that the requested changes persisted.

Use it to assign and schedule work, process a batch of records, or hand a request
between its creator and an approver. Session renewal, explicit transaction
recovery and retained observations help a flow continue reliably or stop with
its uncertain effects preserved. The same operations support application testing,
including checking that creators cannot approve their own work.

Workflows use native [Robot Framework](https://robotframework.org/) steps, with
Python and JavaScript APIs underneath. You describe your application's controls
and expected outcomes. Shared operations handle forms, React/Vue components,
bounded waits and saved-state checks. Failed prerequisites stop dependent steps.

The included [collaboration flow](src/treadway/authoring/project/collaboration.robot)
demonstrates creation, approval and confirmation across separate user sessions:

```robotframework
${author}=    Open Fixture Identity    author    casey
${reviewer}=    Open Fixture Identity    reviewer    sam
${request}=    Create Shared Request    ${author}
${approved}=    Approve Shared Request    ${reviewer}    ${request}
Observe Approved Request    ${author}    ${approved}    ${reviewer}
```

Treadway is pre-1.0 and runs on Linux. It requires Python 3.11+, Node 22+ and a
separately installed Chrome or Chromium browser. The package includes browser
control code, guides, an agent skill and a runnable example app.

## What makes a workflow dependable

- **Checked intent and prerequisites.** Application mappings establish the actual
  user, resource, revision and required state before dependent actions proceed.
- **Recovery that accounts for effects.** Supported HTTP mutations retain durable
  intent and dispatch records. After an uncertain result, reconcile the original
  operation before deciding whether another attempt is justified.
- **Separate identities and session lifetimes.** Owned browser profiles and HTTP
  cookie jars support user handoffs and application-specific session renewal.
- **Evidence beyond a successful click.** Keep intended values, interaction
  receipts, observed responses and independent persisted-state checks distinct.
- **Visibility and efficient execution.** Live diagnostics and run statistics
  expose machinery costs; objective-directed optimisation can omit unnecessary
  work while preserving the required guarantees and evidence.

Your adapter defines application semantics and authoritative observations.
Treadway supplies reusable enforcement and recovery mechanics; a timeout or
successful HTTP response alone cannot establish the business outcome.

## Try the local example

Start in a directory where you can create the checkout and a sibling `my-flow`
directory. These commands download Python and Node dependencies, activate a
virtual environment and create an editable example project. Keep your
environment's proxy and CA settings.

```sh
git clone https://github.com/craigbalding/treadway.git
cd treadway
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[robot]'
npm ci --ignore-scripts
treadway new ../my-flow
cd ../my-flow
python run.py check
```

The offline check should finish with `"passed": true`. It checks the example's
code and Robot structure within a 15-second budget, without starting an app or
browser.

To run the browser example, use your installed Chrome executable. The command
below uses Google Chrome's standard Linux path; replace it if yours differs.
The runner starts a local workboard and sandboxed browser with a fresh profile,
creates synthetic records and cleans them up. Logs remain in `my-flow/artifacts/`.
Keep Chromium's sandbox enabled under gVisor. Sandboxed startup and this example
have been verified in SafeYolo using gVisor; see
[sandbox support](docs/BROWSER-SESSIONS.md#chromium-sandbox-in-gvisor).

```sh
CHROME_BIN=/usr/bin/google-chrome python run.py test
```

Success means two passed Robot cases, `"passed": true` and
`"liveConditionsVerified": true`. The cases create, assign and schedule an item,
verify it after reload, and confirm that a stale edit cannot overwrite a newer
revision. If a check fails, inspect the log path printed beside it.

## Build your own flow

Use the [walkthroughs](docs/EXAMPLES.md) to understand the example, then follow
the [authoring guide](docs/AUTHORING.md) to map your own app's controls, identity
checks and saved-state observations. The generated project includes the same
guides and a `.agents/skills/treadway-flows/` skill for your coding agent.

From the generated project, run `python run.py check` while editing and the
affected Robot suite when ready. The [fast feedback guide](docs/FAST-FEEDBACK.md)
explains focused checks and the browser acceptance steps.

| Task | Guide |
| --- | --- |
| Create, assign and hand work between users; exercise permission rules | [Guided examples](docs/EXAMPLES.md) |
| Reuse a persistent profile or isolate identities | [Browser and actor sessions](docs/BROWSER-SESSIONS.md) |
| Supply credentials from environment variables, 1Password or optional vaults | [Credentials](docs/CREDENTIALS.md) |
| Sign in with Entra, including TOTP and first-login setup | [Entra flow](docs/ENTRA.md) |
| Continue repeated mutations across session expiry | [Session recovery](docs/SESSION-RECOVERY.md) |
| Shorten a flow for the operator's objective and assurance requirements | [Flow optimisation](docs/FLOW-OPTIMISATION.md) |
| Debug flow machinery, inspect run statistics and report contract changes | [Diagnostics](docs/OBSERVABILITY.md#live-progress-and-run-statistics) |
| Inspect step screenshots, retained attempts and native Robot results | [Screenshots and execution logs](docs/OBSERVABILITY.md#screenshots) |
| Map forms, autocomplete, dates and editors | [Forms](docs/forms.md) · [React/Vue widgets](docs/REUSABLE-WIDGETS.md) |
| Call Python or JavaScript directly | [API index](docs/API.md) |
| Install a wheel and its locked Node dependency | [Installation](docs/INSTALLING.md) |
| Contribute or publish a GitHub release | [CI and releases](docs/RELEASING.md) |

Credential providers include an optional
[SafeYolo](https://github.com/craigbalding/safeyolo) gateway adapter. Applications
bind the shared login flow to their own principal checks and permission rules.

Read [the library boundary](BOUNDARY.md) and [validated capabilities and limits](docs/VALIDATION.md)
for scope, or the optional [Browser backend comparison](docs/BROWSER-COMPARISON.md)
for ongoing upstream reuse work.
