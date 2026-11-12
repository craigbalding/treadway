# Treadway

**Reusable browser workflows for humans and agents.**

Create a record, assign its owner and verify that the saved values survive a
reload. Have a second user approve it, and check that the creator cannot approve
their own work. Treadway supplies the browser operations, separate user sessions
and checks needed to build flows like these.

Workflows use native [Robot Framework](https://robotframework.org/) steps, with
Python and JavaScript APIs underneath. You describe your application's controls
and expected outcomes. Shared operations handle forms, React/Vue components,
bounded waits and saved-state checks. Failed prerequisites stop dependent steps.

For example, the included [collaboration flow](src/treadway/authoring/project/collaboration.robot)
contains this sequence:

```robotframework
${author}=    Open Fixture Identity    author    casey
${reviewer}=    Open Fixture Identity    reviewer    sam
${request}=    Create Shared Request    ${author}
Attempt Self Approval And Verify Refusal    ${author}    ${request}
${approved}=    Approve Shared Request    ${reviewer}    ${request}
Observe Approved Request    ${author}    ${approved}    ${reviewer}
```

Treadway is pre-1.0 and runs on Linux. It requires Python 3.11+, Node 22+ and a
separately installed Chrome or Chromium browser. The package includes browser
control code, guides, an agent skill and a runnable example app.

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
| Hand work between users; test self-approval and private-resource access | [Guided examples](docs/EXAMPLES.md) |
| Reuse a persistent profile or isolate identities | [Browser and actor sessions](docs/BROWSER-SESSIONS.md) |
| Supply credentials from environment variables, 1Password or optional vaults | [Credentials](docs/CREDENTIALS.md) |
| Map forms, autocomplete, dates and editors | [Forms](docs/forms.md) · [React/Vue widgets](docs/REUSABLE-WIDGETS.md) |
| Call Python or JavaScript directly | [API index](docs/API.md) |
| Install a wheel and its locked Node dependency | [Installation](docs/INSTALLING.md) |
| Contribute or publish a GitHub release | [CI and releases](docs/RELEASING.md) |

Credential providers include an optional
[SafeYolo](https://github.com/craigbalding/safeyolo) gateway adapter. Applications
remain responsible for login and permission rules.

Read [the library boundary](BOUNDARY.md) and [validated capabilities and limits](docs/VALIDATION.md)
for scope, or the optional [Browser backend comparison](docs/BROWSER-COMPARISON.md)
for ongoing upstream reuse work.
