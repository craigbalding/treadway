# Your Treadway flow project

This project runs a small local workboard. Use it to learn how Robot keywords,
application mappings and Treadway's browser operations fit together, then adapt
one operation at a time for your own application.

## Run the first flow

Use the Python environment with Treadway's Robot extra and locked Node dependency
installed. Set `CHROME_BIN` to your installed Chrome or Chromium; keep the sandbox
and your proxy/CA settings enabled.

```sh
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot
```

Expect `"passed": true`; the browser run also reports two passed Robot cases and
`"liveConditionsVerified": true`. It starts its own local app and fresh browser,
then cleans up its records. Check the printed artifact path on failure.
`check` has a 15-second budget; `test` has a 60-second budget.

## Choose the next example

| Task | Run from this directory |
| --- | --- |
| Reassign and reschedule the same work item | `CHROME_BIN=/path/to/chromium python run.py test --suite handoff.robot` |
| Create as A, approve as B; test self-approval and private access | `CHROME_BIN=/path/to/chromium python run.py test --suite collaboration.robot` |
| Continue 100 REST mutations across session expiry | `python -m robot --pythonpath . --outputdir artifacts/recovery session_recovery.robot` |
| See live progress and run statistics | `python debug_recovery.py --level DEBUG` |
| Inspect a proposed faster path without executing it | `python optimise_flow.py --describe` |

The browser examples use synthetic workboard records. The recovery and debug
examples start a disposable local HTTP app and need no browser or external account.
All evidence stays under private ignored `artifacts/` directories.

## Make it your own

Start in the `.robot` suite to change the sequence. Use `adapter.py` for application
checks and saved-state observations, and `browser.cjs` for selectors and requests.
Add an adapter operation only when the existing keywords cannot express the task.
Run `check`, then the affected suite after each change.

- [Walkthroughs](.agents/skills/treadway-flows/references/WALKTHROUGH.md) explain the browser examples.
- [Authoring](.agents/skills/treadway-flows/references/AUTHORING.md) covers adapting an application.
- [Recipes](.agents/skills/treadway-flows/references/RECIPES.md) point to shared operations.
- [Agent skill](.agents/skills/treadway-flows/SKILL.md) gives your agent the same starting point.
- [Session recovery](.agents/skills/treadway-flows/references/SESSION-RECOVERY.md),
  [diagnostics](.agents/skills/treadway-flows/references/DIAGNOSTICS.md) and
  [optimisation](.agents/skills/treadway-flows/references/OPTIMISATION.md) cover those examples.

The original workboard is unauthenticated. Collaboration routes use synthetic
accounts named in `identities.json`; keep real credentials in private sources.
