# Use remote browsers

**Browserserve is the recommended remote provider.** A lost connection can resume
the same running browser, including its page, JavaScript memory, login and unsaved
input. Treadway captures the resume capability automatically, isolates projects
and actors, and preserves unanswered actions for investigation.

Start with [Browserserve setup and reconnect](../src/treadway/authoring/skill/treadway-flows/references/BROWSERSERVE.md),
also available as `treadway guide browserserve`. The generated project includes
`browser.browserserve.json`; the normal flows accept it with `--browser-config`.
The service needs a route to the application, supplied separately from the
runner's local observer route.

[Choose a provider](../src/treadway/authoring/skill/treadway-flows/references/REMOTE-BROWSERS.md)
compares the options. Existing Browserless deployments remain supported through
[their setup guide](../src/treadway/authoring/skill/treadway-flows/references/BROWSERLESS.md).
Choose the provider explicitly; a failed connection never switches services.
Without remote configuration, the local walkthrough uses local Chrome.

Use [Browserserve acceptance and deployment notes](reference/BROWSERSERVE-ACCEPTANCE.md)
for the verified version, Docker configuration, checks and limits.
The [Browserless reference](reference/BROWSERLESS.md) and
[acceptance record](reference/BROWSERLESS-ACCEPTANCE.md) cover its optional
reconnect and Session API contracts.
