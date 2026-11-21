# Browsers, actors and sessions

Use a separate browser profile or HTTP cookie jar for each participant. Reuse a
profile explicitly when later workflows should keep its login and browser cache.
A new workflow does not itself decide whether the profile is fresh or persistent.

## Try a handoff between users

From a generated project:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

The example creates a request as A, checks that A cannot approve it, approves as
B, then checks the result as A. A second case checks a private resource using B
and two separate anonymous sessions. It uses synthetic accounts and verifies
saved state independently. Expect two passed Robot cases and retained logs.

## Start and stop a browser

```python
from pathlib import Path
from treadway.browsers import BrowserManager

manager = BrowserManager(Path("private-artifacts/browsers"))
session = manager.start("reviewer", executable="/absolute/path/to/chromium",
                        persistent=True)
try:
    with manager.drive(session):
        connection = session.connection()
        # Pass connection to your browser operation here.
finally:
    manager.stop(session)
```

This is lifecycle scaffolding: the comment is where your operation runs.
`drive` gives that operation exclusive control of this session. Distinct sessions
can run concurrently. `stop` closes the owned browser and retains its profile
and logs. See [lifecycle options](SESSION-REFERENCE.md#browser-lifecycle) for
startup budgets, reattachment, exact targets and Chrome switches.

For browser cleanup, use the owning manager's `stop(session)` operation. Do not
replace it with `pkill -f` or a broad Chromium/name-pattern kill: the pattern can
match the invoking shell or workflow wrapper, and another session may share it.
If the handle is no longer in memory, read the recorded handle and compare its
generation with the one retained for the session you intend to stop:

```python
session = manager.recorded("reviewer")
if session.generation != expected_generation:  # from the retained browser receipt
    raise RuntimeError("browser_generation_differs")
manager.stop(session)
```

`recorded` also supports shutdown after the page closes. `stop` verifies process
identity before signalling, so a reused PID is not treated as the old browser.
If ownership cannot be established, retain the failure and resolve it rather than
substituting a broader kill. A process exit or freed session lock does not settle
an application effect; reconcile any uncertain submission before another attempt.

With `persistent=True`, restarting `reviewer` reuses that named profile. With the
default `persistent=False`, startup uses a fresh profile. A restart returns a new
generation; old handles cannot be reused. Choose a different name for a different
participant, including a second anonymous user.

## Make compared fixtures distinguishable

Give compared users, records and before/after states distinct valid synthetic content and
recognisable markers. This applies to document bodies, text fields, titles, filenames and
structured records as well as images. A different object ID alone does not make identical
content distinguishable. Preserve comparability; deliberately identical data is an explicit
test condition with its purpose and observation limits recorded.

Generate each default image fixture for its associated synthetic user or record. Include a
large readable alias/fixture label plus a different shape/pattern or colour scheme, such as
`ACTOR A / PHOTO 01` and `ACTOR B / PHOTO 02`. Keep text/shape recognisable at the actual display
size or crop; colour, a filename or a digest alone is insufficient for visual evidence. Bind
the label to the actual principal and saved object IDs in retained setup/evidence. Markers
must not contain credentials or real personal data.

Verify each owner's successful baseline and the marker in the persisted representation before
using it for cross-identity or state comparisons. Account for legitimate rendering/transforms.
An existing identical fixture is a limitation, not permission to reupload, overwrite a saved
record or replay an uncertain action merely to improve its evidence.

## A profile label is not a principal

Before acting, check the application's current user through the session that
will perform the action. Naming a profile `reviewer` does not log it in.
[Credentials](CREDENTIALS.md) provide secret references; [Entra](ENTRA.md) provides
one supported login flow.

Pass resource IDs and expected revisions between participants. Each participant
builds its own browser bindings. Share neither credentials nor prepared edits.
For a permission test, send the intended request as the intended user and inspect
the application's refusal; a hidden button or local guard is insufficient.

Use [session recovery](SESSION-RECOVERY.md) for repeat operations that need to
renew expired authentication. Ordinary `HttpSession.request` does not renew or retry.

## Chromium sandbox in gVisor

Keep the sandbox enabled, including under gVisor. Sandboxed startup and the
example flow have been verified in SafeYolo/gVisor with user namespaces enabled.
A startup timeout is a reason to inspect the retained Chrome log, not to disable
the sandbox. See [sandbox settings](SESSION-REFERENCE.md#chromium-sandbox-in-gvisor)
for diagnosis and the explicit opt-out for environments that cannot support it.

## Reference

- [HTTP sessions and principal probes](SESSION-REFERENCE.md#actor-and-http-apis)
- [Proxy certificate trust](SESSION-REFERENCE.md#https-through-a-trusted-inspection-proxy)
- [Origin storage and target monitoring](SESSION-REFERENCE.md#scoped-state-and-target-observation)
- [Permission checks across users](SESSION-REFERENCE.md#authorization-and-collaborative-handoffs)
