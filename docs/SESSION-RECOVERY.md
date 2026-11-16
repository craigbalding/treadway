# Session renewal and repeated mutations

The [installed recovery guide](../src/treadway/authoring/skill/treadway-flows/references/SESSION-RECOVERY.md)
explains application-owned authentication, separate application/IdP credentials,
renewal timing, durable operation intent, reconciliation and explicit replay
permission. Read it from an installed package with `treadway guide recovery`.

The shipped `session_recovery.robot` walkthrough performs 100 distinct mutations
against a disposable local application. It renews an expired application session
and reconciles a lost mutation response without duplicating the write. It uses
native Robot iteration and requires no browser or external service.
