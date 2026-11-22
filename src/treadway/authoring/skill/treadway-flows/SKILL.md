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

Those short budgets exercise the scaffold's local smoke tests. Set a real
journey's overall deadline for the work it must complete, including authentication
and human checkpoints; do not copy a smoke-test deadline into a longer workflow.

## Use practical defaults

Use the SDK's generous response, capture and transfer defaults for ordinary pages,
bundles and files. Do not invent small byte caps, request-count caps or short
timeouts for artificial precision or general caution. A smaller override needs a
concrete test condition or an actual resource constraint; document that reason.
Deliberate limit tests can use small fixtures and explicit limits without making
those limits examples for general workflows. See the current defaults in the
[session reference](references/SESSION-REFERENCE.md#payload-and-observation-budgets).

If an observation exceeds a tool budget, retain the partial evidence and report
the exact limit and operation as a tooling limitation. Do not call it application
rejection or a failed security control. Reconcile dispatched or uncertain actions
before any retry; raising a budget does not authorise replaying a mutation.

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
- Use distinguishable synthetic content and visible identity markers for users,
  records and states a flow must compare; generate separately labelled image
  fixtures. See [fixture identity](references/SESSIONS.md#make-compared-fixtures-distinguishable).
- Preserve uncertain writes until the application observer reconciles them. Keep
  stable operation IDs; neither renewal nor a transport change permits replay.
- Separate actor profiles/jars. Reuse a valid login without deleting state to
  trigger export; required cookie export applies to fresh and reused sessions.
- Stop browsers through their owned session handle and expected generation.
  Broad process-name kills can terminate the invoking shell or another session;
  use the [session lifecycle](references/SESSIONS.md#start-and-stop-a-browser).
- Keep Chromium's sandbox enabled, including under gVisor. Inspect Chrome's log
  before changing launch settings. Imports, constructors and dry-runs stay passive.
- Keep secrets and raw captures private. Shared fixtures use generic names and
  reserved domains. Cleanup has its own recorded outcome and cannot undo a write.
