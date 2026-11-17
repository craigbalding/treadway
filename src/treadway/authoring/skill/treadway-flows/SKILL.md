---
name: treadway-flows
description: Author, diagnose and optimise Treadway web flows for operational automation or application testing. Use when composing Robot flows, mapping application controls, checking persistence, or handling identities and recovery.
---

# Treadway flow authoring

Identify the operator's intended result and required evidence. For a test, also
identify the behaviour under test and deliberate input or session conditions.
Reuse working application keywords before adding operations or changing transport.

## Start or extend a flow

For a new project, run `treadway new DIRECTORY` and follow
[setup and authoring](references/AUTHORING.md). Existing destinations are refused.
The project includes a local app, adapter, Robot suites and this skill.

For an existing project, read its `.robot` file and adapter. A new scenario may
need only a new sequence of keywords. Add selectors, routes, user/resource checks
and saved-state observers in the application adapter; reuse Treadway's mechanics.
Establish the normal working flow before deriving deliberate testing variations.
A consumer of an already proven flow supplies bindings; report implementation
failures to its owner with retained evidence instead of inventing another path.

Run `python run.py check` first (15-second budget, no app/browser), then
`CHROME_BIN=/path/to/chromium python run.py test --suite YOUR.robot` (60-second
budget). Keep the first failure and add a focused regression before fixing it.

## Read only the guide needed for the task

| Task | Guide |
| --- | --- |
| Learn from runnable examples | [Walkthroughs](references/WALKTHROUGH.md) |
| Map forms, choices, dates, editing or transfers | [Recipes](references/RECIPES.md) |
| Separate participants or reuse profiles | [Sessions](references/SESSIONS.md) |
| Use an operator-supplied Browserless service | [Remote browsers](references/REMOTE-BROWSERS.md) |
| Resolve credentials or use a vault | [Credentials](references/CREDENTIALS.md) |
| Sign in through Entra, including supported MFA/setup | [Entra](references/ENTRA.md) |
| Continue repeated REST mutations after expiry | [Recovery](references/SESSION-RECOVERY.md) |
| Show progress or inspect a failure | [Diagnostics](references/DIAGNOSTICS.md) |
| Shorten a proven flow for this operator's objective | [Optimisation](references/OPTIMISATION.md) |

Each guide links to its API details. Do not load every reference for an ordinary task.

## Preserve these execution rules

- Check the actual user, resource and revision inside the dependent operation.
  Carry returned bindings intact between keywords; do not silently refresh stale ones.
- Establish query-specific readiness and the actual option ID before selection.
  Poll observations, never mutations. Do not repair deliberate negative inputs.
- Keep intended values, readback, dispatch, response and saved-state evidence
  separate. A click, HTTP 200 or Robot PASS cannot prove an omitted effect.
- Preserve uncertain writes until the application observer reconciles them. Keep
  stable operation IDs; neither renewal nor a transport change permits replay.
- Separate actor profiles/jars. Reuse a valid login without deleting state to
  trigger export; required cookie export applies to fresh and reused sessions.
- Keep Chromium's sandbox enabled, including under gVisor. Inspect Chrome's log
  before changing launch settings. Imports, constructors and dry-runs stay passive.
- Keep secrets and raw captures private. Shared fixtures use generic names and
  reserved domains. Cleanup has its own recorded outcome and cannot undo a write.
