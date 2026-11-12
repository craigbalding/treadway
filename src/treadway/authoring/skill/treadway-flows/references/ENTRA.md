# Sign in with Microsoft Entra

Use the shared Entra flow for applications that redirect to Microsoft Entra.
Configure the application origin, entry URL, actual-principal probe and identity
references. The same entry point detects an existing authenticated browser,
account selection, email/password, a TOTP challenge and first-login TOTP setup.
The application adapter does not need to reproduce those screen transitions.

## Native Robot example

Install Treadway's Robot extra and its locked Node dependency as described in
the installation guide. Chrome or Chromium is installed separately. Keep the
browser sandbox enabled, including under gVisor.

Create `identities.json` with references, rather than resolved credentials:

```json
{
  "providers": {"env": {"type": "environment"}},
  "identities": {
    "author": {
      "expected": {"user.email": "author@example.invalid"},
      "credentials": {
        "username": {"provider": "env", "name": "AUTHOR_USERNAME"},
        "password": {"provider": "env", "name": "AUTHOR_PASSWORD"}
      }
    }
  }
}
```

Other credential providers use the same named-reference format; see
[credentials](CREDENTIALS.md). For an existing TOTP registration, add a
`totp_secret` credential reference for that identity. First-time enrollment
persists a new seed privately before submitting its verification code.

Create `entra.json` beside it, substituting your own application and absolute
private browser-state paths:

```json
{
  "credentials": "identities.json",
  "scope": "example-uat",
  "application": {
    "origin": "https://workboard.example.invalid",
    "signin_url": "https://workboard.example.invalid/sign-in",
    "principal_probe": "/api/session"
  },
  "browser": {
    "root": "/private/treadway/workboard",
    "executable": "/usr/bin/google-chrome"
  },
  "export_cookies": true,
  "screenshot_mask": "none"
}
```

The probe must return the current session's actual principal. For this example,
HTTP 200 with `{"user":{"email":"author@example.invalid"}}` establishes the
expected identity; a page title, identity alias or cookie's presence does not.
Only the configured expected fields enter the result, rather than the raw
session response. Configure additional exact HTTPS `idp_origins` under
`application` when the tenant uses a different supported login origin.
The principal probe defaults to 5,000 milliseconds; set
`application.principal_timeout_ms` explicitly for a different bounded observation
window, up to 60,000 milliseconds. Results retain safe response status,
completeness, truncation and timing metadata when identity cannot be established.
An unknown result does not establish an expired or invalid session.

Owned browser endpoint verification defaults to a two-second total budget.
`browser.verification_seconds` can select a different positive budget up to 60
seconds without relaxing the process, generation or exact-target checks.

```robotframework
*** Settings ***
Library    treadway.entra_robot.EntraLibrary    ${CURDIR}/entra.json

*** Test Cases ***
Authenticate Author
    ${result}=    Sign In With Entra    author
    Should Be Equal    ${result}[status]    verified
```

Run through native Robot, retaining its JSON output and HTML log:

```sh
python -m robot --outputdir artifacts/login --output output.json login.robot
```

The explicit keyword permits the flow's password and MFA submissions. It does
not retry a failed login. Importing the library, constructing it and Robot dry-run
do not resolve credentials or contact the application.

## Identity and state lifetimes

The native keyword binds a persistent browser profile to the credential
configuration path, scope, application origin and identity. Repeating a flow
for that identity reuses its profile and cache. A different identity has a
separate profile. Each invocation starts and stops its owned browser generation;
the persistent profile remains. An already-running owned session is refused,
so a new invocation cannot adopt and then stop another caller's browser.

For a flow that continues using an already-owned browser, configure
`browser.existing_session` and `browser.generation` with its exact current
BrowserManager handle. In this mode the keyword borrows the selected target,
uses its existing profile and leaves the browser running; its owner performs
cleanup. For example:

```json
{
  "browser": {
    "root": "/private/treadway/workboard",
    "existing_session": "author-browser",
    "generation": "current-generation-from-the-owner"
  }
}
```

This fragment replaces the earlier `browser` object. Obtain the generation
from the actual current handle, rather than copying the illustrative string.
A returned handle from an owned invocation records a stopped browser generation;
it does not provide an active target for later browser steps. JavaScript callers
can pass their existing connected session directly to `EntraLogin` and retain
ownership of its lifetime.
See [browser and actor sessions](SESSIONS.md) for starting a browser, carrying
its current handle between steps and generation-guarded cleanup.

An authenticated browser and a usable HTTP replay state are separate results.
One named session cookie is not a general representation of authentication.
Applications may require several cookies, including same-name cookies with
different paths, or additional browser storage. Preserve the browser profile;
do not delete a valid token to make a login callback run. Required state export
must run after both fresh authentication and authenticated-session reuse.
An export failure must retain the verified authentication observation and report
that the requested state is incomplete.

The native keyword requests app-cookie export by default (`export_cookies:
true`). Its receipt separates `authentication.state` from
`authenticationState.complete`. The latter indexes a private cookie snapshot;
it retains each cookie's metadata and same-name entries. An unavailable required
snapshot returns `authentication_state_incomplete` even when the principal was
verified. Setting `export_cookies` to `false` explicitly opts out.

An HTTP consumer can import the private snapshot into an explicitly bound
`HttpSession` using `import_browser_cookies(snapshot, generation=...)`. Actor,
origin and browser generation must match. Import is atomic and refuses
unsupported partitioned-cookie replay. It does not establish the HTTP client's
actual principal: use that client's own read-only probe before a dependent
operation. Cookies do not represent local storage, IndexedDB, service workers
or bearer tokens held elsewhere in an application.

## MFA and first-login setup

The flow detects the currently supported English Entra screens. It selects a
different authenticator application where offered, chooses manual setup where
available, checks the displayed account name, stages the seed in a private
store, verifies a TOTP code and confirms the candidate after observed completion.
It does not replace an existing seed or assume an absent account name matches.

The native store retains separate pending and confirmed records under the
identity's private browser root. An interrupted pending enrollment stops a later
invocation for reconciliation before another code submission. Keep the pending
record: it may be the only copy of a seed whose enrollment partly completed.
JavaScript consumers can supply their own private `stage`/`confirm` store.

Unsupported challenges or setup screens remain explicit incomplete states.
Do not introduce an account fallback, repeated password submissions, password
changes, consent acceptance or a different MFA method to make the test pass.
Tenant policy determines whether another authenticator application is offered.

## Diagnose one attempt

Every attempt gets a unique private directory before application execution.
Structured observations and action-start records are appended as execution
progresses, so an interrupted subprocess still leaves evidence. A later success
does not overwrite an earlier failure. Robot's native result and log contain
the concise receipt and paths to the private artifacts.

Inspect the result's status, phase, last screen, transition timings, readiness
conditions, action dispatch state, principal verification and browser cleanup.
An acknowledged click proves dispatch; a missing acknowledgement leaves its
effect unknown. A prep timeout does not establish an account problem or an
infrastructure cause. Reconcile dispatched actions before another login.

Screenshots are captured at observed step boundaries and on failure, rather
than on each browser paint. Screenshot masking is optional and defaults to
`none`. Set `screenshot_mask` to `credentials` to mask credential fields and
known secrets; setup screens are masked in full in that mode. Unmasked setup
screens can include a visible enrollment seed. Screenshots and profiles stay
private; ordinary structured logs redact resolved passwords, seeds and codes.

Use Robot's supported result API to analyse its native outputs. A separate
report parser or logging framework is unnecessary. A timeout or process failure
cannot turn a partial `verified` payload into successful workflow completion.

## JavaScript integration

`browser/entra.js` exports `EntraLogin`, `createPrincipalVerifier` and `totp`.
Construct the flow around an explicit connected session:

```js
const {EntraLogin} = require('/installed/treadway/browser/entra.js');
const flow = new EntraLogin(session, {
  appOrigin: 'https://workboard.example.invalid',
  signinUrl: 'https://workboard.example.invalid/sign-in',
  credentials: async () => resolveThisIdentity(),
  principal: {
    actor: 'author', generation: browserSession.generation,
    probe: '/api/session', expected: {'user.email': 'author@example.invalid'},
  },
  beforeSubmit: async kind => authorizeThisSubmission(kind),
  exportCookies: true,
  evidenceRoot: '/private/treadway/attempts',
});
const receipt = await flow.run();
```

The submission guard must return `true` or `{allowed: true}` explicitly. A custom
`verifyPrincipal` callback can replace the helper, but must establish the actual
principal in this browser session. Callback deadlines bound observation; they do
not cancel external work already dispatched by a callback. Browser mutations
check origin, document, stage and deadline inside the operation itself.
JavaScript cookie export is opt-in through `exportCookies`. When using a custom
verifier, also provide the explicit actor/generation binding in `principal`.
Set `principal.timeoutMs` to configure the shared JavaScript probe's bounded
observation window. The surrounding flow and phase deadlines still apply.
