# Build a flow

Start with the runnable workboard, then replace its application mappings with
your own. Install Treadway using the [quickstart](../README.md#try-the-local-example)
or [wheel instructions](INSTALLING.md).

```sh
treadway new my-flow
cd my-flow
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot
```

Expect two passed Robot cases and `"liveConditionsVerified": true`. The project
includes the app, adapter, local checks and agent skill. No other repository or
external account is required. Use a new destination: `new` refuses existing paths.

To add a scenario, compose existing keywords in a `.robot` file. For a missing
operation, put your selectors and request mapping in `browser.cjs`, and your
user/resource checks and saved-state observer in `adapter.py`. Run the offline
check, then the affected suite after each change.

Follow [the authoring guide](../src/treadway/authoring/skill/treadway-flows/references/AUTHORING.md#adapt-another-application)
for the sequence, or [the walkthrough](EXAMPLES.md) to trace existing keywords.
[Recipes](../src/treadway/authoring/skill/treadway-flows/references/RECIPES.md)
identify the shared helpers for a new interaction.

The same guide is available as `treadway guide start`. For an agent working in
another project, export `treadway skill NEW_DESTINATION` and point it at `SKILL.md`.
