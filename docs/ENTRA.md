# Sign in through Microsoft Entra

Use the shared login flow for apps that redirect to Entra. One entry point handles
existing sessions, account selection, password, supported TOTP challenges and
first-login TOTP setup. It reuses a valid session instead of forcing another login.

[Configure the two JSON files and Robot suite](../src/treadway/authoring/skill/treadway-flows/references/ENTRA.md),
then run:

```sh
python -m robot --outputdir artifacts/login --output output.json login.robot
```

Expect `status: verified`. Inspect the result's evidence paths if login, required
cookie export or browser cleanup fails. [Screenshots and logs](OBSERVABILITY.md)
show where to look; retain the failed attempt before retrying.

The setup guide is also available as `treadway guide entra`. Profile reuse,
borrowing a live browser, cookie import, MFA limits and JavaScript callbacks are
in the [Entra reference](../src/treadway/authoring/skill/treadway-flows/references/ENTRA-REFERENCE.md).
Supported screens are English; tenant policy determines the available MFA choices.
