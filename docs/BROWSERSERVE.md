# Browserserve

Browserserve is the recommended remote provider when retaining live state across
connection loss matters. Treadway uses its native resume header and exact-session
endpoint. Recovery keeps the same actor generation, context, target and deadline;
unknown application effects stay unknown until independently observed.

Use the [installed task guide](../src/treadway/authoring/skill/treadway-flows/references/BROWSERSERVE.md)
for configuration, Python usage, saved identities and cleanup. The command
`treadway guide browserserve` prints the same guide from an installed package.

See the [acceptance and deployment reference](reference/BROWSERSERVE-ACCEPTANCE.md)
for tested behavior and the limits of the evidence.
