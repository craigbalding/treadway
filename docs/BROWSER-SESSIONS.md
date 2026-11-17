# Use separate browser sessions

Give each participant its own profile or HTTP cookie jar, including separate
anonymous users. Choose profile reuse explicitly: `persistent=True` keeps a named
browser profile's login and cache across restarts; the default uses a fresh profile.

## Run a collaboration flow

From a generated project:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

Expect two passed Robot cases. The first creates as A, refuses A's self-approval,
approves as B and verifies as A. The second requests a known private resource as
B and two anonymous users, checking actual application refusals and saved state.

The [session guide](../src/treadway/authoring/skill/treadway-flows/references/SESSIONS.md)
shows browser startup, profile reuse and actual-user checks. It is also available
as `treadway guide sessions`.

## Chromium sandbox in gVisor

Keep Chromium's sandbox enabled, including under gVisor. Sandboxed startup and
the generated flow have been verified in SafeYolo/gVisor with user namespaces.
A timeout does not establish a sandbox failure: inspect the retained Chrome log.
[Sandbox settings](../src/treadway/authoring/skill/treadway-flows/references/SESSION-REFERENCE.md#chromium-sandbox-in-gvisor)
cover diagnosis and the explicit opt-out for an environment that cannot support it.

For flags, proxy trust, HTTP jars and target monitoring, use the
[browser/session reference](../src/treadway/authoring/skill/treadway-flows/references/SESSION-REFERENCE.md).
For expiry during repeated work, see [session recovery](SESSION-RECOVERY.md).
