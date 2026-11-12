# Identity credentials

The self-contained [credential guide](../src/treadway/authoring/skill/treadway-flows/references/CREDENTIALS.md)
covers named references, native Robot `Secret` values, environment and 1Password
providers, optional RPA Vault and SafeYolo gateway integrations, custom providers
and the runnable authenticated collaboration example.

Use `treadway guide credentials` from an installed package. Retrieval is explicit
and separate from login, session renewal and actual-principal verification.

For applications using Microsoft Entra, the [shared login flow](ENTRA.md) consumes
these references, verifies the actual browser principal and handles supported
TOTP challenges and first-login enrollment.
