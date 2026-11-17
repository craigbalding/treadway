# Browserless implementation reference

This reference records the design reviewed on 2026-11-17. Fresh sessions, selected
saved state, borrowed attachment and explicit reconnect are now implemented.
Use [the task guide](../REMOTE-BROWSERS.md) for actual APIs and commands, and the
[acceptance record](BROWSERLESS-ACCEPTANCE.md) for tested paths and limitations.
Provider persistence is implemented behind an explicit Session API capability;
owner recovery and final review remain in progress.

The design was reviewed against Treadway commit
`203adc8ffe1e7fb99903ed981a2f891c8ad9bafa`, official Browserless documentation and the
pinned public source linked below. Interface sketches below describe design
requirements; the task guide names the implemented APIs.

## Why a live worker is necessary

Browserless documents its BaaS WebSocket endpoints as launching a browser, and normally
closes that browser when the connection drops. Reusing the same launch URL is not a
stable browser handle. [Connection
endpoints](https://docs.browserless.io/overview/connection-urls), [session
lifecycle](https://docs.browserless.io/baas/session-management).

Before provider integration, `robot.py`, `widgets.py`, `entra_robot.py` and `cdp.py` invoked Node runners that
establish their own CDP connections. Simply replacing host and port with a Browserless
URL would permit one Robot step to inspect one browser and the next to mutate another.
Keep the existing subprocess boundaries, but give them a provider-neutral connection
handle backed by the live worker.

One worker belongs to one run and may hold several actor connections. The first
implementation uses **one Browserless connection/browser allocation per actor**, plus
one owned context in that allocation. This costs one provider slot per active actor. It
avoids introducing cross-actor browser sharing and keeps later persistent identity
lifetimes separate. Sharing one browser between several actors could reduce cost, but is
a separate optimization requiring its own failure and isolation proof.

## Resource and connection contract

Introduce a small `BrowserRuntime` facade with a local implementation wrapping
`BrowserManager` and a Browserless implementation using the worker:

| Operation | Contract |
| --- | --- |
| `acquire(actor, mode, deadline)` | Explicit allocation; durably retain acquisition intent, then returned ownership and selected target before application work. |
| `attach(handle)` | Observe only the recorded generation; never allocate or search for a substitute. |
| `drive(handle)` | Exclusive operation lease for this actor generation. Different fresh actors/runs can drive concurrently. |
| `connection(handle)` | Produce a versioned connection descriptor; no external URL, auth or remote filesystem path. |
| `release(handle)` | Release only resources recorded as owned, and report incomplete cleanup separately. |

Keep persistence operations separate: `load_identity_state`, `save_identity_state` and
`forget_identity_state` are deliberate state operations, not side effects of `attach` or
`release`. The names above express a proposed interface; implementation should minimize
public additions.

A handle contains `projectId`, random `runId`, actor reference, random `generation`,
provider kind, acquisition mode, safe resource reference, exact context/target binding,
capability results and deadline observations. Project identity is a random ID minted
automatically in private ignored state under the project/configuration directory, not a
directory basename, actor name, URL hash or API token. Project creation may write it;
first explicit execution creates it atomically for existing projects. Concurrent local
starts agree on the same ID; each execution still creates a new run ID. Constructors,
check and dry-run do not create or resolve this state. Fresh mode needs no registration
service. Later persistent identities must retain or deliberately migrate their project
binding; losing or cloning local state cannot authorize adoption of an existing provider
identity. Fresh run and generation identifiers remain unique even when projects are
copied or use identical actor names and credentials. Claims about principal identity
still require the application response.

The opaque resource reference resolves inside the worker to authority returned by
allocation: upstream connection, context ID, target ID, and any provider lifecycle
capabilities. Returned IDs alone are not bearer authorization for another worker. Keep
upstream identifiers private as well: some provider paths can turn a resource identifier
into attachment authority. Public receipts use Treadway-generated aliases. The worker
checks the full run/generation binding and an unlogged IPC capability. Socket
directories are private, files mode `0600`, parent directories `0700`; capabilities
travel over inherited pipes or stdin, not argv. Same-UID malicious processes and a
hostile provider administrator are outside this application-level isolation guarantee.

The new descriptor is discriminated, for example `{kind: "run-worker", version: 1,
runRef, actorRef, generation, targetId}` with its IPC credential conveyed separately.
Keep the existing local descriptor unchanged. Add one connection factory used by all
runners; do not fabricate loopback HTTP discovery or weaken current
`/devtools/page/<id>` validation to accept arbitrary provider URLs.

### Exact target and CDP routing

On fresh acquisition, the worker opens the configured URL once, then performs
`Target.createBrowserContext`, `Target.createTarget` with that context and
`about:blank`, `Target.getTargetInfo` for the returned target, and
`Target.attachToTarget` with flattened sessions. It verifies the exact target's type and
context before exposing it. Use `disposeOnDetach` when the tested provider/browser
supports its semantics. An unsupported context-isolation contract fails acquisition;
there is no default-context or first-tab fallback. These are browser-protocol
operations, not `/json/list` discovery. [CDP Target
contract](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl).

The worker owns command ID allocation and maps replies/events to each operation's
session. A subprocess gets a page-shaped CDP client backed by its selected target
session. Its `close()` detaches its operation sessions only. It cannot close the
upstream browser or change another actor's attachment. Preserve `makeCdpClient`
deadlines, late-reply handling and detached-session failures; multiplexing must not
deliver a late response to a newer command.

Browser-level methods need explicit scope-aware routing. Cookie operations carry the
owned `browserContextId`; page evaluation and origin operations execute on the exact
page session. Never forward arbitrary browser-wide cleanup methods from ordinary
operation clients. `Storage.getCookies` and `Storage.setCookies` support context
selection at the browser endpoint; implementation must test the chosen routing, not
assume a page session and a browser session behave identically. [CDP Storage
contract](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Storage.pdl).

Popup/OOPIF/worker observation must remain a descendant of the selected target or a
verified member of its owned context. `TargetMonitor` currently enables browser-level
auto-attach; that is not safe to reuse on a shared browser. There is no context-ID
selector in CDP's target-type filter. Prefer page-root descendant attachment, verify
context where available, and record incomplete coverage when provenance is missing. Do
not subscribe to all targets and merely redact unrelated results afterward. Full
cross-target monitoring on borrowed/shared browsers stays unsupported until its
attachment behavior is proven safe. Opening a new popup never silently selects it as the
actor's active page.

## Isolation and cleanup on a shared deployment

Fresh means a new empty context, not merely a new WebSocket, actor label or profile
name. Browserless's self-hosted `DATA_DIR` can make sessions share a profile directory.
A fresh context avoids intentionally reading that default profile, but Treadway must
also audit every cookie, state, target and browser-level helper for context scope. It
must not claim disk/process isolation or protection from deployment extensions/hooks.
Shared `DATA_DIR` can also cause launch contention independently of browser-context
isolation; the operator should configure a supported deployment with independent
temporary profiles. [Docker
configuration](https://docs.browserless.io/enterprise/docker/config).

Reject explicit persistent-profile launch options in fresh mode rather than silently
rewriting them. Unknown or unsupported launch extensions do not receive an isolation
guarantee merely because the server accepts them. Test the exact supported
deployment/browser combination. A new context failure or missing context identity stops
acquisition before login or application navigation.

| Resource | Default authority |
| --- | --- |
| Owned fresh context returned by this acquisition | Dispose this exact context; never clear another context. |
| Owned targets inside that context | Close exact recorded targets when needed; context disposal releases its descendants. |
| Upstream WebSocket | Close this connection. A disconnect is not evidence that remote cleanup completed. |
| Borrowed browser/context/target | Detach own client sessions only; mutations or cleanup require separately declared permission. |
| Persistent provider session created by Treadway | Retain its returned management capability privately; ordinary run release does not delete saved state. |

The minimum release does not need to send `Browser.close` at all: dispose the owned
context and disconnect its connection. Provider cleanup may then terminate the launched
browser. Never call `Browser.close` on a borrowed/shared browser, never call
deployment-wide disconnect or kill, never list `/sessions`, and never use a
tracking-name match, path substring or process ID supplied by the provider as ownership
proof. No orphan scavenging by account-wide enumeration. A later targeted provider stop
is allowed only for an allocation capability whose provenance and exact lifecycle scope
were retained by this project.

Record cleanup intent and observation independently from application success. If
acquisition dispatched but its response was lost, retain `allocation_unknown`; do not
repeat it or hunt for a session. If context creation was acknowledged, record its ID
before creating the page so partial failure can dispose just that context. If a mutation
is unresolved, stop later dependent operations. Prefer retaining a live context until
the bounded run deadline for explicit reconciliation; terminal teardown may still
release owned resources and must record that it ended further live observation. Teardown
cannot turn an unknown application effect into a rejection.

Run-owner death causes worker shutdown and best-effort scoped cleanup under its own
budget. Private records outlive the worker. A bounded provider session lifetime, when
established by the configured service, is a backstop, not a claim of confirmed deletion.
A client-only ceiling cannot guarantee remote orphan expiry when the provider has no
finite timeout or its remaining lifetime is unknown. Record incomplete cleanup; never
report remote termination merely because the local worker stopped. Never kill an
arbitrary local worker PID: retain local process identity as the current local manager
does. No detached resident service or hosted coordinator is required.

### Concurrency and deadlines

The provider enforces deployment/account capacity; Treadway only bounds its own
requests. An optional local in-flight cap is not a cross-project quota reservation. Do
not inspect, terminate or alter other sessions to free slots. Provider queue limits can
produce `429`; health rejection can produce `503`. Record structured phase/status
without raw response text or endpoint material. [Browserless queue
configuration](https://docs.browserless.io/enterprise/docker/config).

Use one monotonic overall acquisition deadline across proxy connect, TLS, handshake,
queueing, context creation and verification. Per-stage timers are capped by the
remaining budget. Multi-actor acquisition has one run-level budget and releases only its
own acknowledged partial allocations if later actors cannot acquire. Two runs each
holding one slot and waiting for a second therefore terminate boundedly; Treadway does
not add a scheduler or claim atomic slot reservation. No automatic acquisition retries
in the first release, including ambiguous handshake failures. A future explicit retry
policy could retry proven pre-allocation rejection within the original budget, but never
an unknown allocation.

Bound operation, response size, event count, worker inactivity, total run and cleanup
separately. `session_seconds` is a client-side ceiling, not a request to extend the
provider lifetime. The endpoint and its server-side timeout parameters are passed
unchanged. Provider limits may end the browser earlier, even while the client budget
remains. An HTTP timeout or client cancellation does not prove a queued server
allocation was cancelled.

## Endpoint handling, secrets and network placement

Treat the complete endpoint as a secret. Validate scheme/authority and unsupported
fragments/userinfo without converting it into a host/port/path reconstruction. The
documented HTTP-to-WebSocket scheme replacement is the only automatic transformation in
launch mode; preserve the original path prefix, percent encoding, repeated query
entries, signed values and existing authentication. Do not append `/json/version`,
`/json/list`, `/session` or `/devtools/...` by guessing. HTTP discovery is not required
for the first release.

Accept `wss:` and explicitly configured `ws:` in supported environments; policy may
reject insecure or unreachable connections. Support secret handshake headers for a
reverse proxy separately from Browserless query authentication. Reject conflicting
authentication definitions instead of overwriting them. URLs, all query values,
userinfo, auth headers and secret-bearing path segments must never enter stdout, stderr,
Robot arguments/reports, diagnostics, exception strings, receipts or argv. Display only
a configured safe alias, protocol, phase and structured error code. Sanitization
includes upstream error bodies, WebSocket close reasons and nested transport errors.

Use the existing remote HTTP-proxy requirement. Extend `cdp-proxy.js` for full
`ws`/`wss` URLs, HTTPS where later management APIs require it, CONNECT, TLS hostname
verification and the configured CA environment. TLS goes through the tunnel with the
endpoint hostname as SNI. Remote policy failures do not authorize direct access,
disabled verification, changed proxy settings or a local browser fallback. Redirects are
disabled by default. Provider-returned URLs need an explicit accepted authority policy,
including approved fleet hosts; never forward credentials to an arbitrary returned
origin. Incorrect self-hosted external URLs are deployment configuration failures, not
invitations to rewrite prefixes or hosts heuristically.

There are two independent network paths: the local runner connects to Browserless, while
the remote browser connects to application and identity-provider origins. Local HTTP
helpers in `sessions.py` still originate from the runner and may have different DNS,
cookies, IP policy and reachability. A browser in a cloud fleet cannot reach the
runner's loopback fixture just because CDP is reachable. Self-hosted browser networking
also differs from the runner's namespace. An operator supplies reachable bindings or an
explicitly managed network facility; Treadway does not create tunnels, change browser
proxy egress or transfer local proxy credentials implicitly.

## Authentication, saved state and borrowing

Browser session lifetime, provider token validity and application authentication
lifetime are independent. A live socket, successful state restore or provider session ID
never proves the application's current principal. Keep `ActorBrowser` checks and
resource/revision prerequisites within the dependent operation. Authentication expiry
returns an observed unmet prerequisite, not a hidden login/retry.

Fresh mode never discovers prior identity state. State export/import is explicitly bound
to project, application origins, identity reference, format/version, source generation
and declared completeness. Files are private credentials. Sharing the same Browserless
account, actor name or identity label does not import another project's state.
Cookie-only export is not a full browser profile: required session storage, IndexedDB or
other unsupported state must cause a clear incomplete/unsupported result, not a claim of
successful preservation. Partitioned-cookie limitations in the local HTTP bridge remain
explicit. Exporting a cookie artifact does not authorize HTTP replay from another
network location.

Later modes have distinct contracts:

| Mode | Stable resource and release behavior |
| --- | --- |
| Explicit state snapshot | Start fresh context, import only selected scoped state, verify actual principal; export only when requested. Disk/profile persistence is not implied. |
| Live reconnect | Use only a previously returned reconnect capability for this actor generation. Confirm the same context and exact target still exist. Failure never falls back to launch. |
| Provider persistent identity | A recorded provider session/profile survives runs under an exclusive identity lease. A new browser process gets a new generation and invalidates old page/control handles. |
| Borrowed target/context | Require explicit endpoint, exact selected context/target, declared scope and allowed operations. Ownership remains with the operator; no context/profile deletion. |

Browserless's standard reconnect API returns a URL after `Browserless.reconnect`; its
idle grace does not override the original session deadline. That feature is optional,
not the basis of subprocess continuity. Reconnect authentication must follow the tested
API contract and preserve existing parameters, rather than blindly appending a second
`?token`. No call is made unless reconnect is explicitly enabled. [Standard
reconnect](https://docs.browserless.io/baas/session-management/standard-sessions), [CDP
extension reference](https://docs.browserless.io/api-reference/cdp-extensions).

Browserless's cloud/Enterprise Session API is different: creation returns `connect` and
`stop` URLs with tokens already embedded; stored profile state may survive a browser
restart while tabs do not. Its `stop` URL deletes saved session data. A later adapter
takes an explicit Session API creation URL, retains the returned lifecycle URLs
privately, and separates `release connection` from `forget saved identity`. It must not
infer this API from an OSS launch URL. [Persisting
state](https://docs.browserless.io/baas/session-management/persisting-state).

For provider persistence, the default incognito context cannot preserve a profile across
process restarts. A dedicated, verified per-session profile/default context is therefore
a different isolation contract, permitted only when that exact provider capability
ensures it belongs exclusively to the identity. Arbitrary self-hosted `DATA_DIR` or
`userDataDir` strings are not sufficient. Initial self-hosted persistence should use
scoped snapshots or remain unsupported; a profile adapter needs an operator-assigned
exclusive resource and a tested lifecycle.

The persistent identity key is `(projectId, application scope, identityRef, provider
binding)`. Also exclude simultaneous writers to the actual provider profile/session
resource. Different project keys do not make a shared remote resource independent. If
two configurations name the same remote resource, require a common resource lease and
explicit cross-project sharing permission, or refuse the second writer. The comparison
key is private and is never the raw endpoint/token in a log. Acquire its exclusive
writer lease before any restore, login, drive or export; hold it for the entire
connection/state-update lifetime, including read operations that may refresh tokens.
Existing same-host file locks provide cooperative multi-process exclusion only when all
participants share the same trusted state root and lock domain. Do not present a lock
filename or timestamp lease as distributed fencing. Moving/cloning state or using
several hosts needs an external serialization/fencing facility supplied by the consuming
environment; until integrated, concurrent multi-host writers are unsupported. Provider
single-client rejection is useful defense, not proof of a general distributed lease.

Generations fence stale commands within a live worker. They cannot fence an already
accepted remote application action. After owner loss or network partition, a released
local file lock is insufficient evidence that the old browser is no longer driving. Mark
the identity recovery-required; use documented provider exclusion/termination or an
established lifetime bound to prove the previous connection ended before new write
access. Preserve and reconcile unresolved application effects separately. No automatic
takeover, lock stealing, reconnect to a newly started default page, or login renewal.

## Failure and evidence semantics

| Observation | Result |
| --- | --- |
| Validation/capability refusal before dispatch | `not_dispatched`; do not contact the application. |
| Rejected allocation handshake | Structured rejected phase/status; no action executed. Preserve uncertainty if allocation acceptance is not established. |
| Socket dropped or worker died | `transport_lost`; remote session state unknown unless independently observed. All pending dispatched commands remain unknown. |
| Provider explicitly reports expiration or target gone | `session_expired` or `target_missing` with evidence; no fresh generation substitution. |
| Action sent, reply missing/late | Existing attempt remains unknown; no retry or replay. |
| Same session recovered | Revalidate exact target, current principal and resource prerequisites; recovery does not resolve prior effects. |
| Cleanup reply missing | `cleanup_incomplete`; preserve resource reference and next scoped recovery action. |

A later explicit reconnect opens the recorded capability once, under a budget, and
resumes observation only after generation checks. It does not resend pending CDP
commands. Application-specific observers reconcile uncertain writes using the durable
attempt and independently persisted application state. Within a live worker generation,
a duplicate IPC request identifier returns its retained status and never dispatches the
command again. After worker restart, a missing receipt is unknown; this is not
crash-safe exactly-once delivery, and the identifier does not permit replay. Reconcile
the durable attempt before issuing a new mutation.

Operation subprocess timeout, death or IPC disconnection does not cancel an accepted
remote `Runtime.evaluate`, input event or application request. The worker records the
unresolved dispatch and quarantines dependent mutation work even if its local lock has
become available. A new operation lease permits only explicitly scoped reconciliation
until the prior effect and any still-running command are resolved. Lease expiry is not
remote fencing. Worker crash recovery preserves this uncertainty before deciding whether
cleanup or later mutation is permitted.

Screenshots and existing CDP evidence can be returned as bytes and written privately by
the local runner. Provider recordings/live views are optional capabilities with their
own access/retention policy; they do not replace action receipts or independent
persistence evidence. Do not enable provider recording, stealth, CAPTCHA solving or live
sharing implicitly.

`transfers.js` currently passes local absolute paths to `DOM.setFileInputFiles` and
watches a local download directory. These mechanisms are unsupported for remote
browsers. Fail before dispatching a remote upload or download-triggering action unless
an explicitly tested transfer capability is selected. A future transfer adapter must
move bytes across a scoped channel, enforce size/hash/deadline checks, retain exact
remote object ownership, and clean up only its objects. Browserless extension
availability and file semantics must be verified separately; no shared filesystem
assumption or direct-HTTP substitute for a browser action.

## Provider evidence and support claim

Research used official documentation and public source only, on 2026-11-17; no provider
session was started. Pin real acceptance to an immutable Browserless image
digest/version, Chromium version and deployment mode. Current public source was
inspected at
[`83acacfc2761edba242b2dc388599f9c3a611c42`](https://github.com/browserless/browserless/tree/83acacfc2761edba242b2dc388599f9c3a611c42),
dated 2026-11-16. This is research provenance, not a recommendation to deploy an
unreleased main commit.

| Evidence | Consequence for this design |
| --- | --- |
| [OSS launch route](https://github.com/browserless/browserless/blob/83acacfc2761edba242b2dc388599f9c3a611c42/src/shared/chromium.ws.ts) proxies browser CDP and declares launch behavior. [Existing-browser route](https://github.com/browserless/browserless/blob/83acacfc2761edba242b2dc388599f9c3a611c42/src/shared/browser.ws.ts) requires an already running browser. | Launch and attach are separate modes; never infer ownership from a URL shape alone. |
| [Browser manager source](https://github.com/browserless/browserless/blob/83acacfc2761edba242b2dc388599f9c3a611c42/src/browsers/index.ts) distinguishes new allocation, existing-browser attachment and connection-count/keep-until cleanup. Its metadata path can launch a temporary browser. | Keep one upstream allocation alive; don't treat arbitrary HTTP metadata probes as passive. |
| [OSS deployment guide](https://docs.browserless.io/enterprise/open-source) demonstrates CDP with a new browser context and separates Enterprise features. | Standard CDP contexts are a plausible common baseline; BQL and commercial extensions are not an OSS support promise. |
| [Config source](https://github.com/browserless/browserless/blob/83acacfc2761edba242b2dc388599f9c3a611c42/src/config.ts) and [Docker reference](https://docs.browserless.io/enterprise/docker/config) expose deployment-specific defaults. | Browserless branding and a valid token do not establish isolation, retention, quota or timeout configuration. |
| [Session API guide](https://docs.browserless.io/baas/session-management/persisting-state) describes persistent profile state, process lifetime and single-client access separately. | Preserve separate profile/generation/connection identities; require capability-specific tests. |

The initial compatibility promise is scoped to tested Chromium CDP behavior, fresh
contexts and the operator's configured endpoint contract. Runtime feature verification
can reject unsupported endpoints but cannot certify unseen provider hooks, storage
configuration, account isolation or administrator behavior. Cloud fleet behavior,
reconnect extensions, Session API persistence and remote transfers remain unverified
until authorized acceptance against those exact services. No cloud feature is inferred
to exist in OSS v2, and Enterprise self-hosting is a separate product capability set.

## Staged implementation and release gates

1. **Connection and scope contracts.** Add the facade/descriptor in `browsers.py` or a small adjacent module, preserving the local API. Add scoped context/target metadata and ownership records. Review `cookies.js`, `state.js`, `actors.js`, `targets.js` and `transfers.js` before enabling remote capabilities. Constructors remain passive.
2. **Transport and live worker.** Extend `cdp-proxy.js` with policy-preserving full-URL WSS support; add the run worker and private IPC. Factor connection setup in `cdp.js` while retaining its existing local path and deadlines. Implement fresh context acquisition, command/event isolation, generation checks, bounded teardown and redaction. No provider management service or SDK dependency is necessary for standard CDP.
3. **Flow integration.** Route `form-assessor.js`, `widget-runner.js`, `entra-runner.js` and `bridge.js` through the common connection factory; extend `robot.py`, `widgets.py`, `cdp.py` and `entra_robot.py` to accept the handle while preserving old arguments. Entra chooses an explicit browser/state mode; its current `persistent=True` local assumption must not silently become a remote persistence claim. Keep actual-principal and uncertain-effect behavior unchanged.
4. **Shipped workflow.** Add an explicit `--browser-config` selection to `authoring/project/run.py`; pass that configuration into the provider facade. Update collaborative/optimization examples and session guidance with one minimal remote configuration, explicit private-target reachability, capability errors and cleanup receipts. Existing adapters that launch Chrome directly must migrate to the facade; provider-aware application keywords need no transport-specific fork. Include worker assets via `pyproject.toml` and installed browser package assets. Verify exported/scaffolded projects work without source-checkout paths or Browserless credentials in generated output.
5. **Optional capabilities.** Add explicit borrowed attachment, scoped state snapshots, reconnect and provider persistent identities only after their ownership/recovery gates pass. Remote transfer support and broader target monitoring are independent capabilities, not prerequisites for core fresh-mode release.

Fast tests should use local deterministic protocol fixtures, avoiding paid sessions and
external applications:

| Test group | Required cases |
| --- | --- |
| URL/proxy/TLS | WSS through CONNECT, trusted/untrusted CA, exact reverse-proxy path, encoded/repeated/signed query values, secret handshake headers, IPv6 authority, auth rejection, redirect refusal, truncated errors, no secret in logs/argv/receipts, no direct fallback. |
| Stable session | Two operation subprocesses navigate/write then read the same exact context/target over one upstream launch; operation exit does not disconnect it; stale target/generation refused. |
| Isolation | Two projects sharing the exact URL/token; two concurrent runs in one project using the same actor label; multiple actors; dirty default profile; cookie/localStorage/IndexedDB and capture sentinel data never cross scopes. |
| Lifecycle | Owned context cleanup leaves unrelated contexts alive; borrowed teardown only detaches; worker/owner crash; partial allocation; lost create reply; no global sessions/kill/Browser.close; cleanup failure does not erase application result. |
| Uncertainty | Server records a write then drops its reply; command count remains one through client timeout, late response, worker loss and explicit recovery. No launch retry after unknown acquisition. |
| Deadlines/capacity | Delayed CONNECT/TLS/handshake/reply, provider queue saturation, two partially acquired multi-actor runs, bounded cleanup; all work respects one remaining acquisition budget. |
| State/identity | Context-specific cookie routing, wrong project/origin identity snapshot refusal, same-host competing writers, owner loss requiring recovery, expired app auth despite live browser, unsupported full-state claims. |
| Capability/passivity | Missing Target methods fail before navigation/login; remote upload/download refuses before effect; constructors/check/dry-run resolve no secret and make no request. |
| Packaging | Existing local tests pass; wheel-installed worker and runners work from another directory; generated project offline checks remain offline; remote fixture integration runs from installed package. |

Extend `test_cdp_proxy.js`, `test_cdp_deadlines.js`, `test_target_sessions.js`,
`test_browsers.py`, actor/cookie/transfer tests and installed authoring tests. Run
focused contract tests first, then `test:browser:fast` and the affected actual
Robot/browser composition. Real Browserless acceptance requires an explicitly authorized
test deployment: pin an OSS image, run the same multi-project/multi-run isolation and
unknown-reply suite, and keep unrelated sentinel sessions alive throughout teardown.
Cloud acceptance is separate and optional until cloud support is claimed; no paid
sessions are part of this design task.

Release is blocked unless successive subprocess operations demonstrably share the same
selected live target; fresh state and evidence remain isolated across concurrent
projects/runs; cleanup cannot affect an unrelated resource; unknown writes are never
replayed; secrets stay out of output; bounded failures terminate; unsupported
capabilities fail before their effect; and local/installed-package compatibility passes.
Report measured test times, skipped provider modes and exact versions. A passing fake
fixture alone is insufficient to advertise a provider deployment as verified.

## Remaining review choices

The recommended first release is fresh-only, one provider slot per actor, with run-local
IPC and no automatic reconnect. Genuine follow-on choices are which immutable OSS
image/browser pair to certify first, whether the first persistence feature should be
explicit snapshots or the commercial Session API, and which external
writer-serialization contract a consuming multi-host environment can actually supply.
None requires a new scheduler, tenancy server or change to native Robot composition.
