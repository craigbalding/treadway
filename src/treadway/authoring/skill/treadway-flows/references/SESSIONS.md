# Browsers, actors and sessions

Use `treadway.browsers.BrowserManager` for local Chromium lifecycle. Construction
is passive. `start(name, executable=..., persistent=False)` creates a fresh
private profile, a unique generation and exact target; sandboxing is enabled.
`session.connection()` returns the explicit host, port and target for Node APIs.
The manager runs on Linux and verifies process boot/start identity before
reattachment or shutdown. It never adopts an unrelated responding port.

```python
from pathlib import Path
from treadway.browsers import BrowserManager

manager = BrowserManager(Path("private-artifacts/browsers"))
session = manager.start("reviewer", executable="/absolute/path/to/chromium")
try:
    with manager.drive(session):
        connection = session.connection()
        # Pass connection to an installed browser operation.
finally:
    manager.stop(session)
```

`drive` leases one session exclusively; distinct sessions can run concurrently.
Use it around the entire dependent operation, including identity checks and action.
Attach verifies the owned process, browser generation and exact page target.
A closed page requires explicit recovery; another tab is never substituted.
Stop asks Chrome to close gracefully and flush profile data, allowing three
seconds before forcibly stopping remaining owned processes. A forced stop can
lose unflushed state. Stop preserves profiles/logs. Delete an artifact directory only after its sessions
are stopped and the retained state is no longer needed. There is no global reset.
Chrome's temporary socket files use a separate private directory directly under
`/tmp`, keeping socket paths short even when artifact paths are deeply nested.
The manifest records this directory; startup failure and explicit shutdown remove
it. Persistent browser data remains in the named profile.

Startup allows 15 seconds by default and returns as soon as the exact page is
ready. Python callers can set `startup_seconds` up to 60 seconds; the reference
runner also bounds startup by its remaining overall deadline.

`persistent=True` explicitly reuses that named profile after restart. Restart
returns a new generation, invalidating old handles. A running configuration
mismatch fails rather than relaunching. The effective configuration is retained
privately with the manifest. Proxy settings inherit the caller's environment;
CA variables remain intact. No certificate-verification bypass is added.

The same lifecycle is available through `python -m treadway.browsers --root DIR`
with `start NAME --executable PATH`, `attach NAME`, `list`, and `stop NAME`.
`start` accepts `--persistent`, `--headful`, `--no-sandbox` and repeated
`--disable-feature NAME`. Feature changes are explicit test conditions.

The default Chromium switches are `--no-first-run`, `--no-default-browser-check`,
`--disable-background-networking`, `--disable-dev-shm-usage`,
`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=0`,
`--user-data-dir=PROFILE` and `--headless`, followed by a generation-marked blank
page. The OS chooses the debugging port. Explicit options can omit headless mode,
add `--no-sandbox` or `--disable-features=...`; configured proxy settings add
`--proxy-server=...` and, when present, `--proxy-bypass-list=...`.

## Chromium sandbox in gVisor

Sandboxed Chromium startup and Treadway's generated example flow have both been
verified in a SafeYolo environment using gVisor, with user namespaces enabled.
Keep the sandbox enabled by default, including under gVisor. Do not pass
`--no-sandbox`, set `sandbox=False` or set `TREADWAY_CHROME_SANDBOX=off` just
because the runtime is gVisor.

For a normal run, leave `TREADWAY_CHROME_SANDBOX` unset or set it to `on`. Use
`BrowserManager.start(...)` with its default `sandbox=True`. Start the browser
and check the actual result instead of assuming that a container or gVisor
requires disabling its sandbox. A nonzero `/proc/sys/user/max_user_namespaces`
alone does not establish that the browser can use the required namespaces.

If startup fails, inspect the retained Chrome log named in the error. A timeout
alone is not a sandbox diagnosis; browser installation, namespace permissions
and other runtime failures need their own diagnosis. Only an environment that
demonstrably cannot support the Chromium sandbox may explicitly opt out with
`sandbox=False` or the CLI's `--no-sandbox`; the reference runner exposes the
same choice as `TREADWAY_CHROME_SANDBOX=off`. The library never falls back
automatically. These opt-outs disable Chromium's own sandbox.

## A profile label is not a principal

An actor is a workflow participant. A principal is the application's observed
identity; a session is the browser or HTTP state used for an operation. Separate
actors need separate profiles or cookie jars. Two anonymous participants still
need distinct sessions. Multiple sessions may represent the same principal when
testing independent devices, logout, revocation or session propagation.

`browser/actors.js` exports `ActorBrowser(session, {name, origin, probe, expected,
generation})`. Supply a read-only application JSON identity path and exact dotted
identity/tenant/role expectations. `request(path, {method, body})` checks those
expectations through the same browser session, then dispatches once. It returns
the actual response, dispatch status and completeness, including refusals.
`expected: {principal: null}` can establish an application-declared anonymous
state; missing identity fields do not establish anonymous access.

`observePrincipal()` performs only the declared observation. Explicit setup may
use `request(..., {verify:false})`; it neither logs in nor renews automatically.
The application response remains authoritative if identity changes after a probe.
Probes can touch sliding expiry or last-seen state, so keep them out of deliberate
idle-expiry intervals. Preserve pinned anonymous, expired and revoked sessions.

`fillSecret(selector, value)` replaces a credential field and returns only a
boolean receipt. Load secrets inside the helper process, recheck credential
equality immediately before submission in the application login recipe, and keep
credentials out of generic input journals, command arguments and evidence.
This helper does not implement SSO, MFA or application-specific login transitions.
For named identity references, native Robot `Secret` values, 1Password and optional
vault providers, see [credentials](CREDENTIALS.md). The collaboration walkthrough
uses this boundary instead of embedding a password in its browser helper.

`treadway.sessions.HttpSession` owns an independent cookie jar and optional
`credential_headers` callable, read only when requesting its configured origin.
`request` sends one explicit request; redirects are retained, never followed.
`attempt(..., probe="/api/session", expected={...})` verifies identity first.
Neither operation renews credentials, retries work or uses browser cookies
implicitly. Body limits expose incomplete responses; they never turn missing
data into an empty successful result. `observation.headers` is an immutable
tuple of `(name, value)` pairs preserving repeated headers; `observation.header(name,
default=None)` returns the first value with case-insensitive lookup. Headers are
retained on error, redirect and incomplete-body responses, so an adapter can
inspect response metadata without replacing the HTTP transport. Retain bodies
and headers privately: cookies and other credentials may appear in them. Both
are excluded from the observation's default representation. Metadata does not
establish principal identity, permission enforcement or a completed effect.
Response-header and body progress use the remaining timeout budget. DNS and
connection establishment retain the standard library's timeout limitations;
use `run_json_process` around a helper when a strict overall process deadline is
required.

## Authorization and collaborative handoffs

Share resource IDs, run scope and expected revisions between actors. Each actor
observes the resource through its own session and builds its own DOM/prepared
bindings. Never share a browser snapshot, credential or prepared edit across
sessions. Do not silently refresh an old resource revision after another actor
writes it.

Distinguish execution prerequisites from the permission under test. A self-approval
test must submit the intended, otherwise valid action. A cross-user private-ID
test must request that exact known resource as the other user. Do not require
ownership before such an attempt, switch to the owner, repair inputs, or interpret
a missing UI button as server enforcement. Preserve ordinary execution safeguards:
correct session, origin, resource and intentional payload.

Use a positive control to establish resource existence and the other user's
working session. Then require the application's actual refusal, absence of
protected content and independent unchanged persisted state where appropriate.
A transport failure, malformed request, expired prerequisite, truncated body or
missing observation is inconclusive. An independent privileged observer can
inspect effects but cannot stand in for the requesting actor.

## Scoped state and target observation

`browser/state.js` exports `OriginState(session, {origin})`. `observe()` returns
counts or an explicit incomplete observation. `clear()` explicitly clears the
declared origin's storage and verifies it, including a separate HttpOnly-capable
cookie observation. Cookies have domain/path scope rather than port isolation.
HTTP cache and other origins are outside this operation, and other live documents
can repopulate storage. Fresh profiles are the stronger isolation choice.

`browser/targets.js` exports `connectBrowser(proxy, browserPath)` and
`TargetMonitor(cdp, {actor, origin, record, maxEvents})`. Use an explicit owned
browser generation. It observes pages, frames and workers without pausing them,
scopes request IDs by CDP session, omits query strings/headers/bodies, and records
capture limits. It cannot recover traffic before attachment. Declared actor labels
are caller-supplied provenance, not verified application identities.
Use `RequestObserver` for bounded response-body evidence tied to an action.

## Runnable example

After `treadway new my-flow`, run:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

The native Robot suite demonstrates A creating a request, A being refused
self-approval, B approving, and A independently observing the result. Its second
case supplies A's known private resource ID to B and two anonymous sessions. Owner
and B-owned positive controls precede those attempts. `collaborative_flow.py`
owns domain rules and independent SQLite observations; `actors.cjs` composes
installed session-bound browser APIs. Cleanup uses each resource creator's
session, verifies absence independently, and stops only owned browsers.
