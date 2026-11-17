# Use remote browsers

Use an operator-supplied Browserless endpoint while retaining Treadway's actor
sessions, shared interactions and evidence. Choose the provider explicitly;
fresh mode gives each project/run/actor its own browser context and page.

Follow [Browserless setup and usage](../src/treadway/authoring/skill/treadway-flows/references/REMOTE-BROWSERS.md)
for configuration, Python operations, generated examples and failure inspection.
The same guide is installed as `treadway guide remote`.

The [design reference](reference/BROWSERLESS.md) describes the full ownership,
recovery and optional-persistence contracts. Capability work remains in progress;
the task guide distinguishes current behavior from those later modes.

See [acceptance checks](reference/BROWSERLESS-ACCEPTANCE.md) for the tested OSS
version, reproduction commands and the limits of the results.
