# Shorten an existing flow

Start with the operator's objective. A known HTTP write can replace form editing
when the task is to change and verify a saved owner. It cannot replace browser
input when the task is to test the editor's validation.

From a generated project:

```sh
python optimise_flow.py --describe
python optimise_flow.py --bindings 100
CHROME_BIN=/absolute/path/to/chromium python optimise_flow.py --objective validation
```

`--describe` only prints the proposed steps. The next commands execute against a
disposable local app: the first verifies owner changes through HTTP, the second
retains UI validation and checks that no write occurred. Each prints a JSON
result and keeps private artifacts.

Use the [optimisation guide](../src/treadway/authoring/skill/treadway-flows/references/OPTIMISATION.md)
for measured comparisons and offline profiling. It is also available as
`treadway guide optimisation`. [Comparison records and transport rules](../src/treadway/authoring/skill/treadway-flows/references/OPTIMISATION-REFERENCE.md)
are separate reference material; [the design](FLOW-OPTIMISATION-DESIGN.md) explains
the architecture.
