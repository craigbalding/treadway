# Flow authoring kit

The installable authoring guide is maintained with the wheel's skill resources:
[Start here](../src/treadway/authoring/skill/treadway-flows/references/AUTHORING.md).
See the [recipe index](../src/treadway/authoring/skill/treadway-flows/references/RECIPES.md)
for shared operations and [the agent skill](../src/treadway/authoring/skill/treadway-flows/SKILL.md)
for the agent workflow.

Learn through [the executable walkthroughs](EXAMPLES.md), also available as
`treadway guide walkthrough`.

Export the complete runnable reference with `treadway new DIRECTORY` or
`python -m treadway.authoring new DIRECTORY`. Export the standalone skill with
`treadway skill DESTINATION`. Existing destinations are refused. Installed guides
are available through `treadway guide start` and `treadway guide recipes`.

The reference provides a synthetic local application, complete domain adapter,
native Robot flows, independent SQLite readback, stale-revision failure and
observed scoped cleanup. `python run.py check` has a 15-second overall budget;
`CHROME_BIN=/path/to/chromium python run.py test` includes local browser acceptance
with a 60-second overall budget. It runs from the installed package without a source checkout.

Validation of the installed kit and independent fresh-flow trial is recorded in
[the authoring validation ledger](AUTHORING-VALIDATION.md).

For the library's own development checks, see [fast feedback](FAST-FEEDBACK.md).
The full guide also covers adapting another application, reusable checkpoints,
intentional input variations and the distinction between an unmet prerequisite
and an observed application rejection.
