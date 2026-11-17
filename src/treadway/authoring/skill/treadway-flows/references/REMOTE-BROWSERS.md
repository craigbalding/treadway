# Use a Browserless browser

Select Browserless explicitly. Each acquired actor gets a fresh browser context
and page. Its worker keeps the upstream connection alive across your operation
subprocesses; connecting again to the launch URL for every step would allocate
another browser.

## Configure the endpoint

Put a reference in `browser.json`; keep the complete operator-supplied URL in the
named environment variable through your credential tooling:

```json
{"browser":{"provider":"browserless","endpoint_env":"TREADWAY_BROWSERLESS_URL","mode":"fresh","acquire_seconds":15,"session_seconds":300}}
```

HTTP and HTTPS URLs receive only a WebSocket scheme conversion. Paths, existing
query parameters and authentication are preserved. Optional `headers_env` names
an environment variable containing a JSON object of handshake headers. Never put
the actual URL or header values in source, Robot arguments or logs.

Remote connections use the configured HTTP proxy. TLS verification and configured
CAs remain enabled. The remote browser needs its own route to your application;
your runner's loopback address is not generally reachable from Browserless.

## Drive an actor

```python
from pathlib import Path
from treadway.browser_runtime import BrowserRuntime
from treadway.robot import FormLibrary

with BrowserRuntime.from_file("browser.json", root=Path("artifacts/browsers")) as browsers:
    author, reviewer = browsers.acquire_many(["author", "reviewer"])
    with browsers.drive(author):
        forms = FormLibrary(connection=author.connection(),
                            record_path="artifacts/form-attempts.jsonl")
        snapshot = forms.inspect_form()
    # Drive reviewer, then author again: each retains its own page and login.
```

Read `connection()` **inside** `drive()`: it includes that operation's current
lease. Pass it privately to Treadway's Node runners or Python libraries. Keep the
runtime alive while those subprocesses execute. Imports and construction do not
connect or resolve credentials; `acquire()` is the explicit live boundary.

`acquire_many()` has one acquisition budget. If capacity is insufficient, it
releases that call's partial allocations and returns the failure. It does not
retry, close other projects' browsers or fall back to local Chrome.

The project directory receives an ignored private `.treadway/project.json`.
The default project root is the working directory; pass `project_root=` when
running elsewhere. Sharing a provider configuration file does not merge projects.
Concurrent runs share the project identifier, while their actor generations,
contexts and pages stay separate. Browserless credentials do not identify an
application user. Verify the actual principal inside dependent operations.

## Run the generated example remotely

The generated project still runs its own disposable app and observes its local
database. Supply the address through which Browserless can reach **that app**:

```sh
python run.py test --browser-config browser.json --suite collaboration.robot \
  --fixture-host 0.0.0.0 --fixture-port 8765 \
  --app-url http://runner.example.invalid:8765
```

Replace the example address with your operator-configured route. The command
creates no tunnel. `CHROME_BIN` is needed only for the local provider.
`python run.py check --browser-config browser.json` remains offline.

The optimisation example accepts `--browser-config`, `--fixture-host` and
`--browser-app-url`. Its URL may contain the literal `{port}`, which is replaced
with each disposable fixture's selected port. Browserless must be able to reach
those ports. Local HTTP observers continue to run from the runner.

## Save a login for another run

Use a saved identity when a later run should start with the same application's
login. The browser context is still fresh. Treadway restores only the state you
selected, then checks the application's actual user before returning the actor.
It does not log in again or retry a failed restore.

Add a stable safe `binding`, such as `shared-browser-service`, to the browser
configuration. Bind the identity to that alias, your project, the application,
the intended user and the exact application origins:

```python
from treadway.browser_state import BrowserIdentity

identity = BrowserIdentity(
    root=Path.home() / ".local/state/treadway/identities",
    resource="workboard-member", application="workboard", identity_ref="member",
    provider_binding="shared-browser-service",
    origins=("https://app.example.invalid",),
    components=("cookies", "localStorage", "sessionStorage"),
)
principal = {"origin": identity.origins[0], "probe": "/api/principal",
             "expected": {"principal": "member"}}

with BrowserRuntime.from_file("browser.json", root=Path("artifacts/browsers")) as browsers:
    member = browsers.acquire_identity(
        "member", identity, principal=principal,
        landing_url="https://app.example.invalid/workboard",
    )
    # Run your application flow with browsers.drive(member).
    browsers.save_identity(member)  # Explicitly persist any changed login state.
```

For initial setup, acquire with `restore=False`, run your application's normal
login flow, then call `save_identity(member)`. Missing state stops before browser
allocation; it never triggers an implicit login. Saving verifies the actual user
and includes HttpOnly cookies and cookies from every application path. The
principal endpoint must return JSON matching the expected fields.

All runs sharing the same state resource must use the same trusted state root
on one host. The resource has an exclusive writer lease for the entire browser
lifetime. A different project or identity alias cannot bypass it. Independent
roots, copied state and multiple hosts require external coordination.

State files and operation captures contain credentials and stay private. The
snapshot declares its selected components; it is not a browser profile. Web
Storage currently requires one origin; cookie-only snapshots can select up to
eight origins. IndexedDB, cache, service workers and filesystem state are not
captured. Unsupported requirements fail before restore. Cookies use domain/path
scope, so an origin's port is not a cookie isolation boundary.

An owner crash, failed state operation or unconfirmed cleanup leaves the resource
recovery-required. A free local file lock does not establish that the old remote
browser stopped. Do not delete the manifest or force another login to bypass it;
retain its run evidence and establish cleanup and application outcomes first.

After a clean release, `identity.forget(project_id)` explicitly removes saved
snapshots. It refuses active or recovery-required resources, retains their
project binding and does not revoke credentials or erase run evidence. Ordinary
browser release never deletes saved login state.

## Inspect an incomplete operation

Keep the first attempt's private worker `events.jsonl` and operation artifacts.
`browsers.inspect(actor)` returns command references, pending/unknown outcomes
and recorded reconciliations without sending commands to the browser.

For a quarantined actor, Node's `observeSession(connection)` in `connection.js`
allows scoped screenshots, DOM observations and cookie reads. Normal session
setup and arbitrary JavaScript remain blocked. Close this observation connection
when finished.

After your application's independent observer checks the original operation,
retain its private output with:

```python
browsers.record_reconciliation(
    author, request_ref=unknown_request_ref, outcome="applied",
    evidence="artifacts/private-application-observation.json",
)
```

The source must be a private regular file. Treadway saves an immutable copy and
its digest. This records your observer's conclusion; it does not certify that
remote execution stopped, unlock the generation or permit replay. A timeout,
disconnect or cleanup result cannot turn a missing response into rejection.

## Current capability boundaries

Fresh contexts support existing page interactions, actual-user checks,
context-scoped cookies, selected saved state and screenshots. Remote file
transfers, origin clearing and global target monitoring are refused before
dispatch. Borrowing, reconnect and provider persistence require their own explicit
capabilities; they must not be inferred from a launch URL or a local profile flag.

The client session deadline cannot extend the provider's lifetime. Cleanup reports
context disposal separately from provider process termination. Remote Chrome
launch flags are controlled by the service: Treadway's local sandbox setting does
not configure Browserless. In Browserless 2.63.1 the Chromium CDP launcher itself
adds `--no-sandbox`; local Treadway Chrome continues to use its sandbox by default.
