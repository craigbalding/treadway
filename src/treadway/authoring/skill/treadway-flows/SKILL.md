---
name: treadway-flows
description: Author, extend and diagnose Treadway flows using native Robot composition and shared browser operations. Use for Treadway adapters, widget mappings, persistence checks and flow regressions.
---

# Treadway flow authoring

Reuse an existing calibrated domain keyword when it already expresses the intent.
A new scenario can often be only a `.robot` file. For a new operation, keep its
application mapping in the consumer; use installed Treadway mechanics rather than
copying CDP input, controlled-choice, prepared-edit or request-capture code.

For setup, read [the authoring guide](references/AUTHORING.md). To learn through
realistic executable flows, read [the walkthroughs](references/WALKTHROUGH.md):
create/schedule, hand off the same item, and refuse a stale edit.
Run `python -m treadway.authoring new DIRECTORY` for a standalone runnable local
project, or `python -m treadway.authoring guide start` for the installed guide.
The scaffold has a complete app, adapter, offline checks and native Robot examples.
It runs from the installed package without a source checkout.

For a particular interaction, read the matching entry in
[the recipes](references/RECIPES.md): discovery, asynchronous choices, guarded
editing, dates/plain text, request correlation, transfers, independent effects,
interrupted actions or failures. Inspect the actual API before adapting a pattern.
The generated project demonstrates application-specific implementations.

For Chrome launch, profile lifetimes, distinct principals or anonymous users,
read [the session guide](references/SESSIONS.md). Use explicit actor/session
handles, preserve intended authentication conditions, and prove refusal with an
actual application response. The `collaboration.robot` walkthrough demonstrates
self-approval refusal and private-resource access across isolated sessions.
Keep Chromium's sandbox enabled by default, including under gVisor. Sandboxed
startup and the generated example have been verified in a SafeYolo/gVisor
environment. Do not disable it based on the runtime or a startup timeout;
inspect the actual Chrome log.

For named credential sources, native Robot `Secret` values and optional vaults,
read [the credential guide](references/CREDENTIALS.md). Keep references in flow
configuration; resolve explicitly and unwrap only inside a credential-consuming
helper. Resolution does not authenticate or renew a session. Vault authorization
and expected identity labels do not establish the application's actual principal.

Keep these boundaries when authoring:

- Observe the actual actor, target, fields and actions. Labels and framework names
  do not establish actual resource identity or component compatibility.
- Pass returned resource bindings between keywords. Enforce current identity,
  revision and prerequisites inside the operation that depends on them; a
  scenario's earlier check is insufficient. Do not silently refresh a stale handle.
- A query is input, not a selected option. Read-only readiness must establish the
  requested result before retaining its controller binding. Validate the actual
  option ID and select once. Do not poll a mutation or retry it implicitly.
- Preserve sourced intended values, actual readback, action receipt, observed
  response and independent persisted state separately. HTTP 200 or Robot PASS
  cannot prove an omitted business effect. Incomplete execution retains unknown
  effects until the application's observer reconciles them.
- Imports, constructors, `new` and offline checks are passive. Execution and fixture
  mutations are explicit. Keep raw captures private, retain actual created IDs
  immediately, and observe scoped cleanup separately from workflow success.

Develop with `python run.py check` first: a 15-second overall budget, no browser
or app startup. Then `CHROME_BIN=/path/to/chromium python run.py test`: offline
checks plus an isolated local browser flow within a 60-second overall budget.
Use `--suite YOUR.robot` for a targeted flow. A timeout stops observation; it does
not cancel or prove rejection of an already-dispatched action.

When fixing a failure, retain its evidence and add the smallest meaningful local
regression before the fix. Test pending results and changed bindings, not just a
steady page. Run the affected flow before broad application acceptance. Report
which checks actually ran, skips, measured times and remaining limits.
