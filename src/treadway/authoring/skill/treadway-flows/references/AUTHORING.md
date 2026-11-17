# Build a flow with Treadway

Start by running the supplied workboard flow. Then reuse its keywords or replace
its application adapter with your own. Robot controls the sequence; Treadway
handles browser operations, session isolation and recorded results.

## Install and run

Use Linux, Python 3.11+, Node 22+ and an installed Chrome or Chromium. Download a
wheel from [GitHub Releases](https://github.com/craigbalding/treadway/releases),
then replace the wheel path below with your download:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install '/path/to/treadway-0.2.0-py3-none-any.whl[robot]'
TREADWAY_BROWSER_DIR=$(python -c 'from pathlib import Path; import treadway; print(Path(treadway.__file__).parent / "browser")')
npm ci --ignore-scripts --prefix "$TREADWAY_BROWSER_DIR"
treadway new my-flow
cd my-flow
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot
```

Keep your proxy and CA settings. Leave Chromium's sandbox enabled, including
under gVisor. `new` requires a destination that does not already exist.

`check` starts no app or browser and should print `"passed": true` within its
15-second budget. `test` starts a disposable local app and browser. Expect two
passed Robot cases, `"liveConditionsVerified": true` and logs under `artifacts/`.
Its default overall budget is 60 seconds.

## Find the code to change

| File | Change it when you need to… |
| --- | --- |
| `flow.robot`, `handoff.robot` | Compose a different sequence of existing operations. |
| `adapter.py` | Add an application operation, identity/revision check or saved-state check. |
| `browser.cjs` | Map your application's fields, buttons and requests to shared operations. |
| `tests/` | Check a mapping or failure without starting the browser. |
| `run.py` | Understand how the local example starts, checks and cleans up. |

Follow [the walkthrough](WALKTHROUGH.md) to trace a Robot keyword through the
adapter to the browser and database. [Recipes](RECIPES.md) identify shared helpers
for a new interaction.

## Adapt another application

1. State what the operator wants done and how you will check the result. For a
   test, also state the behaviour being tested and any deliberately invalid input.
2. Implement one normal operation with explicit inputs. Check the actual user,
   resource and revision immediately before its dependent action.
3. Return the resource ID and new revision for the next keyword to use. Keep that
   returned binding intact; pass new input as arguments.
4. Check saved state through an application observer, rather than treating a click
   or HTTP 200 as completion. Record created IDs immediately so cleanup can find them.
5. Add a focused failure check, then run the affected Robot suite:

```sh
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite YOUR.robot
```

On failure, open the printed `summary.json` and the failed check's log. Keep the
original attempt. If an action may have reached the app, check its effect before
retrying. [Adapter contracts and runner details](AUTHORING-REFERENCE.md) cover
observers, deliberate variations, deadlines and retained files.

## Give an agent the same guide

The project includes `.agents/skills/treadway-flows/`. For a standalone copy:

```sh
treadway skill ~/.codex/skills/treadway-flows
```

The destination must be new. If the agent does not discover repository skills,
point it at `SKILL.md` directly. Exporting a skill does not authorize live actions.
