# Use a Browserless browser

Select Browserless explicitly. In the default fresh mode, each acquired actor
gets a fresh browser context and page. Its worker keeps the upstream connection alive across your operation
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

For a Browserless snapshot owner, request recovery using the previous run's
retained binding:

```python
identity.recover(saved_project_id, run_id=saved_run_id,
                 actor="member", generation=saved_generation)
```

This reads the run recorded before that owner's allocation. It requires an
acknowledged disposal of its exact context and no unresolved application effects.
It refuses a live identity lease, mismatched binding, incomplete journal or
unconfirmed cleanup. A successful recovery permits a new `acquire_identity()`;
it never resumes the old generation. The next restore checks the actual user
again. This path does not recover local browser owners or provider profiles.

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

If the worker has exited, read the retained journal without contacting Browserless:

```python
from treadway.browser_receipts import inspect_browser_run

observed = inspect_browser_run(
    saved_run_directory, project_id=saved_project_id, run_id=saved_run_id,
)
```

Save those three binding values privately while the runtime is alive; they are
`browsers.evidence`, `browsers.project_id` and `browsers.run_id`. A missing reply
stays unknown. A torn or malformed journal retains its valid prefix and reports
incomplete evidence. Reconciliation counts as resolved only while its private
evidence copy still matches its recorded digest. `journalComplete` describes the
record syntax, not application success or remote termination. This reader grants
no new lease and performs no recovery, reconnect or replay.

You can also retain an independent application observation after worker exit:

```python
from treadway.browser_receipts import record_browser_reconciliation

record_browser_reconciliation(
    saved_run_directory, project_id=saved_project_id, run_id=saved_run_id,
    actor="author", generation=saved_generation,
    request_ref=unknown_request_ref, journal_sha256=observed["journalSha256"],
    outcome="applied", evidence="artifacts/private-application-observation.json",
)
observed = inspect_browser_run(
    saved_run_directory, project_id=saved_project_id, run_id=saved_run_id,
)
```

This writes a separate private receipt and leaves the journal intact. A later
journal append makes that observation stale. Conflicting conclusions or changed
evidence keep the effect unresolved. A torn journal stays incomplete even when
an observation resolves one effect. Recovery still requires independent proof
that the previous remote execution was fenced; application state alone is
insufficient.

## Borrow an existing page

Use borrowing when an operator supplies an existing browser context and exact
page. Ownership stays with the operator. Release detaches Treadway's own CDP
sessions; it does not close the page, dispose the context or erase its state.

Configure a distinct entry point:

```json
{"browser":{"provider":"browserless","mode":"borrowed","binding":"shared-browser-service","attachment_env":"TREADWAY_BORROWED_ATTACHMENT"}}
```

The named environment variable contains private JSON with these exact fields:

```json
{"version":1,"endpoint":"wss://browser.example.invalid/devtools/browser/EXISTING","contextId":"EXACT_CONTEXT_ID","targetId":"EXACT_PAGE_ID","scope":"context","permission":"observe"}
```

Use the actual existing-browser endpoint supplied by your operator or provider.
A launch endpoint is unsuitable: Treadway never discovers a browser by listing
all sessions or falls back to a new page when the selected target is absent.
The context must be explicit; borrowing the browser's default context is not
supported. Context scope permits reading that context's complete cookie jar,
including cookies belonging to its other pages. This is not a page-only grant.

Use a `BrowserIdentity` and the same trusted state root for every cooperating
writer, as above. Treadway leases both the named identity and the actual context
resource. A second alias or project cannot bypass that context lease.

```python
from treadway.cdp import CdpSocket, CommandSession

with BrowserRuntime.from_file("borrowed-browser.json", root=Path("artifacts/browsers")) as browsers:
    observer = browsers.borrow("member", identity)  # Read-only by default.
    with browsers.drive(observer):
        socket = CdpSocket(connection=observer.connection(), observation_only=True)
        try:
            page = CommandSession(socket).command("DOM.getDocument", {"depth": 1})
        finally:
            socket.close()
```

Observation uses an allowlist of DOM, accessibility, cookie and screenshot
queries. It cannot evaluate arbitrary JavaScript, navigate, enter data or modify
cookies. Normal form/widget initialization therefore requires an explicit
`permission="drive"` in both the operator's attachment and `borrow()`. An
observation connection remains read-only even when its actor has drive permission.

Borrowing does not verify the application's user. Driving flows must retain their
actual-principal and resource checks inside dependent operations. To explicitly
export selected state, supply the same `principal=` binding used for saved
identities and call `save_identity()` from a drive-capable actor.

Screenshots remain bounded observations. A hidden page may not supply a drawable
surface, so retain an incomplete capture alongside other evidence. Treadway does
not bring an operator's page to the front, change its viewport or retry the capture
implicitly. Lost transport or unconfirmed detach leaves the resource
recovery-required; snapshot recovery cannot establish a fence for a borrowed
browser. Do not delete its state manifest to force reuse.

## Reconnect to the same live browser

The run's worker already keeps a browser connected between operation processes.
Reconnect is an optional provider feature for a deliberate disconnect or later
transport loss. Enable it explicitly in fresh mode:

```json
{"browser":{"provider":"browserless","endpoint_env":"TREADWAY_BROWSERLESS_URL","reconnect":{"auth_env":"TREADWAY_BROWSERLESS_TOKEN"}}}
```

Omit `auth_env` when the returned URL needs no added token. When configured, the
token is resolved only during preparation and added as a query parameter if
absent. An existing different or duplicate token causes refusal. Returned URLs
and provider replies stay in private run files; method results contain references.

```python
prepared = browsers.prepare_reconnect(member, timeout_seconds=30)
# Continue the flow, or deliberately reconnect using only that capability:
result = browsers.reconnect(member, principal=principal, timeout_seconds=10)
```

Call these outside `drive()` after closing the operation's connection. Preparation
requires a healthy actor; it calls `Browserless.reconnect` once. Reconnect consumes
that prepared capability once, closes the old connection, and validates the same
context, page and actual application user before normal driving is available.
It keeps the original generation and session deadline. Prior unknown actions stay
quarantined; successful reconnect does not authorize replay.

By default, a returned endpoint must use the original WebSocket origin. If your
deployment returns a different routing origin, explicitly list it in
`reconnect.allowed_origins`, for example `["wss://route.example.invalid"]`.
TLS downgrades are refused. Original handshake headers are sent only to the
original origin. No endpoint discovery, redirect or launch fallback is attempted.

Provider support and authentication vary. An unavailable extension, missing
capability, expired deadline, changed target or changed user stops the operation.
Additional reconnect authentication is supported only when embedded in the
returned URL; unrecognized contracts are refused. A prepared capability cannot
resume a dead worker or recover a borrowed browser. These paths have been checked
with protocol fixtures and real Chromium behind an emulated reconnect relay;
Browserless cloud reconnect has not been verified. See the [provider's session
contract](https://docs.browserless.io/baas/session-management/standard-sessions).

## Keep a provider profile between runs

Use this when browser cache, persistent cookies and local storage must survive a
browser restart. The operator must supply a Browserless **Session API** URL. This
capability is distinct from a CDP launch endpoint and is not available in the
tested open-source service. Treadway uses the returned connection and deletion
URLs exactly; it never guesses an API path from a browser URL.

Put the private URL in `TREADWAY_SESSION_API_URL` and use:

```json
{"browser":{"provider":"browserless","mode":"provider-session","binding":"shared-browser-service","session_api_env":"TREADWAY_SESSION_API_URL","acquire_seconds":20,"session_seconds":300}}
```

Use a `BrowserIdentity` as in the saved-login example, with the same application,
user and provider bindings. Give provider profiles their own identity resource;
snapshot identities and provider profiles cannot share a manifest. Keep the state
root private and share it among all cooperating writers on the same host.

Create and initialize the profile explicitly, once:

```python
with BrowserRuntime.from_file("profile-browser.json", root=Path("artifacts/browsers")) as browsers:
    browsers.create_provider_identity(identity, ttl_seconds=3600)
    member = browsers.acquire_provider_identity(
        "member", identity, principal=principal, initial_setup=True,
    )
    with browsers.drive(member):
        # Run the normal sign-in flow using member.connection().
        sign_in(member.connection())  # Your application's flow.
    browsers.verify_provider_identity(member)
    cleanup = browsers.release(member)
```

`principal` is the same origin/probe/expected-user binding used for saved logins.
The initial setup actor is available to sign in; it does not establish the user
until verification succeeds. Later acquisitions verify the actual application
user before returning an actor:

```python
with BrowserRuntime.from_file("profile-browser.json", root=Path("artifacts/browsers")) as browsers:
    member = browsers.acquire_provider_identity(
        "member", identity, principal=principal,
        landing_url=principal["origin"] + "/",
    )
    with browsers.drive(member):
        run_flow(member.connection())  # Your application's flow.
    cleanup = browsers.release(member)
```

A new acquisition opens a new page and gets a new generation. Persistent profile
state survives; page handles, tabs and session memory do not. Application login
can still expire. A failed user check stops acquisition and retains its evidence;
it does not trigger an implicit login or a replacement profile.

Release asks this profile's dedicated browser to close and requires both the CDP
acknowledgement and connection closure. `profileReleased` and `profileRetained`
report this separately from context disposal. To permanently delete a cleanly
released profile, explicitly call `browsers.forget_provider_identity(identity)`.
It sends one request to the recorded deletion URL. An active or abandoned lease
blocks deletion. A missing response remains unknown and blocks automatic reuse;
do not delete manifests to bypass it.

Treadway leases both the named identity and the actual provider session ID, so
aliases cannot bypass exclusion under the same trusted state root. Local file
locks do not coordinate different hosts. Do not share one profile across hosts
without an external exclusion mechanism. The provider controls profile TTL;
Treadway does not renew it automatically.

Connection and deletion URLs remain in private capability files. If a provider
returns a different routing origin, explicitly allow its HTTP origin in
`session_allowed_origins`; HTTPS cannot downgrade to plaintext. Optional
`headers_env` supplies headers to the creation API and same-origin returned URLs.
Credentials are not forwarded to another origin.

The Session API contract is tested with an emulated service. Real Chromium
checks verify separate processes, persisted state and unrelated-browser survival.
Cloud and Enterprise Session API behavior remains unverified. See the
[provider's persistence guide](https://docs.browserless.io/baas/session-management/persisting-state)
for availability and profile semantics.

## Current capability boundaries

Fresh contexts support existing page interactions, actual-user checks,
context-scoped cookies, selected saved state and screenshots. Remote file
transfers, origin clearing and global target monitoring are refused before
dispatch. Borrowing, reconnect and provider persistence require the explicit
capabilities above; none is inferred from a launch URL or a local profile flag.

The client session deadline cannot extend the provider's lifetime. Cleanup reports
context disposal separately from provider process termination. Remote Chrome
launch flags are controlled by the service: Treadway's local sandbox setting does
not configure Browserless. In Browserless 2.63.1 the Chromium CDP launcher itself
adds `--no-sandbox`; local Treadway Chrome continues to use its sandbox by default.
