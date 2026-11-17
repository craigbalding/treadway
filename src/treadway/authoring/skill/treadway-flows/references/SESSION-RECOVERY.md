# Maintain authentication during repeated mutations

Put the repeated work in a normal Python or Robot loop. Give each mutation a
stable operation ID. `OperationExecutor` uses your application's authentication
callbacks to renew a session when permitted, and retains each mutation's result
so a lost reply does not silently cause a duplicate write.

## Run 100 mutations

From a generated project, with the Robot extra installed:

```sh
python run.py check
python -m robot --pythonpath . --outputdir artifacts/recovery session_recovery.robot
```

No browser or external account is needed. The fixture expires its application
session after write 37 and loses the reply to write 63. Expect one passed Robot
case, exactly 100 writes and one renewal. The independent database check confirms
write 63 without sending it again.

The suite supplies each binding explicitly:

```robotframework
FOR    ${index}    IN RANGE    1    101
    ${receipt}=    Execute Recovery Binding    ${index}
    Should Be Equal    ${receipt}[state]    confirmed
END
```

In `session_recovery.py`, binding N sends `{"id": "item-N", "value": N}`.
`Execute Recovery Binding` is an example application keyword. Read it alongside
the suite to see the actual owner callbacks, payload and saved-state checks.

## Use it with your application

Configure one `OperationExecutor` with:

- The HTTP session and a private journal directory.
- A read-only identity probe and the expected user.
- An `AuthenticationOwner` that uses the application's supported refresh,
  browser SSO or login mechanism. It must respect permission for interactive login.
- Callbacks that check the original resource and observe or reconcile the effect.

The [API example](SESSION-RECOVERY-REFERENCE.md#compose-one-calibrated-operation)
shows the constructor and `execute` call. Application and identity-provider
credentials can expire separately; renewing one need not renew the other.
Use the application's existing SDK/cache when it owns token acquisition.

Maintenance is off by default. Enable it explicitly for ordinary repeat work.
For a deliberate expiry test, leave renewal off and suppress incidental principal
probes only when the test requires that condition; probes can extend sliding sessions.

## When a request fails

Keep the original operation ID and payload. A 401 can justify configured session
renewal; it does not by itself permit resending a mutation. Reconcile a possibly
committed write first. Repeating a completed operation returns its saved receipt,
not a new write or proof of current application state.

A failed operation exposes `OperationIncomplete.receipt` and a private evidence
path. Check that evidence before recovery. Keep raw cookies, headers and bodies
private. [Recovery rules](SESSION-RECOVERY-REFERENCE.md#decide-effects-separately-from-renewal)
define when replay is allowed; the [owner reference](SESSION-RECOVERY-REFERENCE.md)
covers rotating tokens, browser-cookie import, coordination and deadlines.
