# Treadway

**High-assurance web workflows for humans and agents.**

Treadway helps you carry out work in web applications and check what happened.
Compose browser and HTTP operations to assign records, process a batch or hand
work between a creator and an approver. The same operations support testing,
such as checking that a creator cannot approve their own request.

Flows use [Robot Framework](https://robotframework.org/), Python or JavaScript.
Your adapter defines the application's controls, users and expected results.
Treadway supplies shared browser operations, separate sessions, explicit recovery
and retained evidence. A timeout leaves an uncertain action available for
investigation instead of silently repeating it.

## Try the local example

Requires Linux, Python 3.11+, Node 22+ and a separately installed Chrome or
Chromium. Keep your environment's proxy and CA settings.

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

Expect `"passed": true`. This checks code and Robot structure within a 15-second
budget, without starting an app or browser. For a packaged installation, use
[the wheel instructions](docs/INSTALLING.md#from-a-github-release).

Run the browser example, replacing the Chrome path if needed:

```sh
CHROME_BIN=/usr/bin/google-chrome python run.py test --suite flow.robot
```

Expect two passed Robot cases and `"liveConditionsVerified": true`. The runner
starts a local workboard and fresh browser, creates and schedules an item, checks
it after reload, and proves a stale edit cannot overwrite a newer revision. It
cleans up its records; logs remain in `my-flow/artifacts/`. Open the printed log
path if a check fails. Keep [Chromium's sandbox enabled](docs/BROWSER-SESSIONS.md#chromium-sandbox-in-gvisor),
including under gVisor.

## Build your own flow

Start in the generated `.robot` file to reuse existing keywords. Change
`adapter.py` for application checks and saved-state observations, and
`browser.cjs` for selectors and requests. The [authoring guide](docs/AUTHORING.md)
explains each step. The generated project includes the same guides and an
`.agents/skills/treadway-flows/` skill for your agent.

For a flow involving multiple users, run `collaboration.robot`. Its keywords
make the handoff explicit:

```robotframework
${author}=    Open Fixture Identity    author    casey
${reviewer}=    Open Fixture Identity    reviewer    sam
${request}=    Create Shared Request    ${author}
${approved}=    Approve Shared Request    ${reviewer}    ${request}
Observe Approved Request    ${author}    ${approved}    ${reviewer}
```

[Guided examples](docs/EXAMPLES.md) explain the returned values and checks.
[Fast feedback](docs/FAST-FEEDBACK.md) shows what to run while editing.

| Task | Guide |
| --- | --- |
| Use a remote browser, with live reconnect | [Browserserve (recommended)](docs/BROWSERSERVE.md) · [Other providers](docs/REMOTE-BROWSERS.md) |
| Isolate users or reuse a browser profile | [Sessions](docs/BROWSER-SESSIONS.md) |
| Use environment credentials, 1Password or optional vaults | [Credentials](docs/CREDENTIALS.md) |
| Sign in through Entra, including supported TOTP setup | [Entra](docs/ENTRA.md) |
| Continue a batch after session expiry | [Session recovery](docs/SESSION-RECOVERY.md) |
| Shorten a proven flow for your objective | [Optimisation](docs/FLOW-OPTIMISATION.md) |
| Show progress or inspect screenshots and failures | [Logs and screenshots](docs/OBSERVABILITY.md) |
| Map forms and React/Vue controls | [Forms](docs/forms.md) · [Widgets](docs/REUSABLE-WIDGETS.md) |

Treadway is pre-1.0. The package includes browser-control code, guides, an agent
skill and a local example app; Node and the browser are installed separately.
Optional credential providers include [SafeYolo](https://github.com/craigbalding/safeyolo).
Use the [documentation index](docs/README.md) for API references, contributor
instructions, design records and validation history. [Project scope](BOUNDARY.md)
explains what your application adapter must provide.
