# Sign in with Microsoft Entra

Use the shared Entra flow for applications that redirect to Microsoft Entra.
Configure the application origin, entry URL, actual-principal probe and identity
references. The same entry point detects an existing authenticated browser,
account selection, email/password, a TOTP challenge and first-login TOTP setup.
The application adapter does not need to reproduce those screen transitions.

## Native Robot example

Install the Robot extra and locked Node dependency using [setup](AUTHORING.md#install-and-run). Chrome or Chromium is installed separately. Keep the
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
Use the exact fields your probe returns. Configure additional login origins and
observation budgets only when your application needs them; see
[probe configuration](ENTRA-REFERENCE.md#probe-and-startup-budgets).

Save the suite as `login.robot`:

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

## Check the result

Expect `status: verified`. The keyword verifies the application user, exports
required app cookies by default and retains the attempt's screenshots and logs.
If it fails, start with `Get Last Entra Result`, then its `robotEvidence` and
`evidence.directory` paths. Authentication, cookie export and cleanup have
separate results; an export failure is not a reason to force another login.

Screenshots default to no masking. `screenshot_mask: "credentials"` masks input
values and known secrets, and hides authenticator setup screens in full. Keep
screenshots and profiles private. [Attempt evidence](ENTRA-REFERENCE.md#diagnose-one-attempt)
describes retained files and incomplete outcomes.

## Reuse a session or handle MFA

Repeating the same identity/configuration reuses its persistent profile and
browser cache. Different identities get separate profiles. The default keyword
stops its owned browser after login; to keep using a live browser, configure
[an explicitly borrowed session](ENTRA-REFERENCE.md#identity-and-state-lifetimes).

Supported English screens include password, TOTP and first-login setup using an
alternative authenticator where offered. Unknown screens stop with evidence.
Keep a pending enrollment seed after interruption; inspect it before another code
submission. See [MFA support](ENTRA-REFERENCE.md#mfa-and-first-login-setup).

The [reference](ENTRA-REFERENCE.md) covers JavaScript callbacks, complete cookie
import and upstream SSO reuse without a password. Application-session refresh
is configured separately through [session recovery](SESSION-RECOVERY.md).
