# Use Browserserve

Browserserve is Treadway's recommended remote provider for flows that need to
survive a dropped connection. Each acquisition gets a fresh context and page in
a dedicated service browser. A native resume capability retains that same live
browser after transport loss; it is captured automatically and kept private.

## Connect

The operator supplies a Browserserve endpoint with
`BROWSERSERVE_RESUME_WINDOW_MS` set to a positive window, for example `30000`
for 30 seconds. Upstream defaults to zero, which disables resume; that endpoint
will fail acquisition with `remote_browserserve_resume_unavailable`. Set
`BROWSERSERVE_REQUIRE_SANDBOX=1` and choose `BROWSERSERVE_STEALTH=0` when browser
modifications are unwanted. The actor's original session deadline still bounds
recovery even when the service window is longer. Use the
shipped `browser.browserserve.json` in a generated project, or create:

```json
{"browser":{"provider":"browserserve","binding":"shared-browser-service","endpoint_env":"TREADWAY_BROWSERSERVE_URL","headers_env":"TREADWAY_BROWSERSERVE_HEADERS","acquire_seconds":15,"session_seconds":300}}
```

Put the complete URL in the named environment variable through your credential
tooling. The optional `headers_env` value is a JSON object of handshake headers,
such as an Authorization header. Omit that reference if the supplied URL already
provides authentication. Keep credential values out of source, Robot arguments
and logs. Resolution happens only when `acquire()` is called.

HTTP(S) URLs receive a WebSocket scheme conversion; paths and opaque query
parameters are preserved. Proxy selection uses the existing HTTP(S)_PROXY,
NO_PROXY and ALL_PROXY settings. TLS checks the endpoint host and configured CAs.
No failed proxy connection falls back to a direct route.

## Run and recover

```python
from pathlib import Path
from treadway.browser_runtime import BrowserRuntime

principal = {"origin": "https://app.example.invalid", "probe": "/api/principal",
             "expected": {"principal": "member"}}

with BrowserRuntime.from_file("browser.browserserve.json",
                              root=Path("artifacts/browsers")) as browsers:
    member, reviewer = browsers.acquire_many(["member", "reviewer"])
    with browsers.drive(member):
        run_flow(member.connection())  # Your application's calibrated flow.
    # If the service connection is lost, close the failed operation first.
    result = browsers.reconnect(member, principal=principal)
    # Verify whether the original operation completed using its retained evidence.
    print(result["reconciliationRequired"])
```

Call `reconnect()` outside `drive()`, after the operation's connection is closed.
There is no `prepare_reconnect()` step. Reconnect attaches only to the original
context and target, verifies the application's actual user, and retains the
original generation and session deadline. It can recover the same browser again
if another connection drops later. A healthy connection can also be explicitly
reconnected, using the same checks.

A missing or malformed resume header fails acquisition. A refused or expired
capability, changed page or changed principal stops recovery. Treadway never
falls back to the launch endpoint, another browser, another user or another page.
The service controls the resume window; reconnect before that window expires.
The client session deadline still applies. Browser restarts, service restarts
and owner-worker death are outside this live reconnect contract.

An unanswered command remains unknown after successful reconnect. Normal driving
stays quarantined; `inspect()` returns the receipts and `observeSession()` permits
scoped read-only observations. Record the independent application outcome with
`record_reconciliation()`. That record does not prove that remote execution
stopped or authorize replay. See [incomplete operations](BROWSERLESS.md#inspect-an-incomplete-operation)
for the shared evidence APIs.

## Keep users and projects separate

Use one acquired actor per principal or anonymous session. Sharing the endpoint
and service credential does not share application state. A private project ID,
run ID, actor generation, context and target bind every operation. Leave the
runtime alive across operation subprocesses; reconnecting to the launch endpoint
for each step would allocate another browser.

Saved logins use the same `BrowserIdentity`, `acquire_identity()` and
`save_identity()` APIs as other fresh contexts. See [saved login snapshots](BROWSERLESS.md#save-a-login-for-another-run).
These selected snapshots are distinct from live reconnect: they do not preserve
an old page, JavaScript memory, IndexedDB or cache. Verify the actual user after
restoring a snapshot. Borrowed pages and Browserless Session API profiles are
separate capabilities and are not accepted by this provider configuration.

## Finish a run

`release()` disposes the owned context, then closes its dedicated browser.
`providerSessionClosed` requires both the CDP `Browser.close` acknowledgement
and subsequent connection closure, separately from `contextDisposed` and unknown
application effects. A WebSocket EOF alone cannot establish this result.
It does not attest that every remote OS process has exited. An already lost
connection may leave cleanup unconfirmed until the service's resume window ends;
Treadway does not silently reconnect just to claim cleanup succeeded.

An acknowledged shutdown of the dedicated browser also fences its context when
the separate disposal acknowledgement is missing. Treadway retains
`contextDisposed: false` as observed and records the stronger provider-session
fence separately. Unknown application effects still require reconciliation.

The operator should enable `BROWSERSERVE_REQUIRE_SANDBOX=1` and choose browser
modifications explicitly, including `BROWSERSERVE_STEALTH=0` when they are unwanted.
Treadway's local Chrome flags do not configure the remote service. Provider defaults
must be evaluated for your deployment. See the upstream
[Browserserve project](https://github.com/browser-gateway/browserserve) for deployment.

The adapter has a fast protocol check (`npm run test:browserserve`) and an opt-in
real-service check (`npm run test:browserserve:service`). Only point the latter at
an isolated service owned by that check: it observes aggregate session counts.
