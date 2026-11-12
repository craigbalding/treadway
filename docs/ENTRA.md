# Microsoft Entra sign-in

The shared [Entra guide](../src/treadway/authoring/skill/treadway-flows/references/ENTRA.md)
shows native Robot configuration, named identities, persistent profiles,
automatic MFA/setup detection, private state and failure evidence.

Read it from an installed package with `treadway guide entra`. The same guide
ships with the exported agent skill.

The integration is tested with synthetic HTTPS screens in a real sandboxed
Chromium browser. Those checks exercise email/password, Other authenticator
setup, manual seed retention, TOTP, existing-session reuse and native Robot
result logging. They do not establish compatibility with every tenant, locale
or MFA policy. Microsoft documents the tenant-dependent choices in
[first-login security setup](https://support.microsoft.com/en-US/accounts-billing/work-school/set-up-security-info-from-a-sign-in-page).
