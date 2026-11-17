# Continue work across session expiry

Use `OperationExecutor` with your application's authentication callbacks for
repeated authenticated HTTP mutations. Keep each operation's ID and payload
stable; a session renewal does not itself authorize repeating a write.

## Try 100 mutations

From a generated project, with the Robot extra installed:

```sh
python -m robot --pythonpath . --outputdir artifacts/recovery session_recovery.robot
```

Expect one passed case: 100 distinct writes, one renewal after expiry, and a
lost response reconciled without repeating its write. No browser or external
service is required. Read `session_recovery.py` alongside the suite to see the
changing payload and actual refresh and effect-check callbacks.

The [task guide](../src/treadway/authoring/skill/treadway-flows/references/SESSION-RECOVERY.md)
shows the loop and application setup. The
[API reference](../src/treadway/authoring/skill/treadway-flows/references/SESSION-RECOVERY-REFERENCE.md)
covers authentication ownership, independent app/IdP expiry, rotating refresh
tokens and replay permission. The installed guide is `treadway guide recovery`.
