---
name: treadway-flows
description: Author, diagnose and optimise high-assurance web workflows for the operator's objective using native Robot composition and shared operations. Use for operational automation, application testing, adapters, persistence and recovery.
---

# Treadway flow authoring

Establish the operator's objective and required assurance: performing work and
testing application behaviour are both supported. Use the intended identities,
preserve transaction state and retain evidence of the actual outcome. Application
bindings define the business rules and authoritative observers.

To optimise an existing flow, use [objective-directed optimisation](references/OPTIMISATION.md).
First establish what the operator wants to accomplish and the required guarantees
and evidence. For testing, identify the specific behaviour and boundary under
test. Reuse proven application knowledge to omit unnecessary work. Keep
intentional negative inputs and session conditions; a faster execution that
changes the objective is not a valid candidate. Produce ordinary Python/Robot
code, named evidence obligations and a measured comparison. The offline helpers
analyse retained records; they never execute a proposed flow.

For live flow/machinery diagnostics, run statistics and material contract changes,
use [the diagnostics guide](references/DIAGNOSTICS.md). Enable one run scope or
native Robot listener. Inspect observed facts and private evidence; a timeout
alone does not prove the application changed. Keep uncertain effects unresolved
until the calibrated observer establishes them.

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

For Microsoft Entra sign-in, use the [shared login flow](references/ENTRA.md).
Configure application and identity bindings; one entry point detects session
reuse, password, TOTP and first-login setup. Preserve complete required state
and first-attempt evidence. Do not force a fresh login to trigger state export.

For repeated authenticated REST mutations, use the [recovery guide](references/SESSION-RECOVERY.md)
and `session_recovery.robot`. Configure the application's authentication owner;
keep IdP and application renewal separate. Reuse its SDK's credential acquisition.
Do not infer refresh endpoints, treat a 401 as replay permission, overwrite newer
HTTP state with an old browser export, or repair original resource bindings.
Use stable operation IDs and explicit effect reconciliation for uncertain writes.

Establish and verify the normal application flow before deriving testing
variations. Keep reusable execution mechanics in the shared flow and put the
application's selectors, routes, identity expectations and fixtures in bindings.
When a testing task has a frontier author/reviewer and a consuming agent, the
consumer supplies bindings and uses the proven flow; implementation failures
return to the flow owner with retained evidence.

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
- Shared fixtures use generic app names, invented identities and reserved example
  domains. Keep real organisation and private-platform identifiers in private
  consumer bindings; provider/framework names may identify the actual integration.

Develop with `python run.py check` first: a 15-second overall budget, no browser
or app startup. Then `CHROME_BIN=/path/to/chromium python run.py test`: offline
checks plus an isolated local browser flow within a 60-second overall budget.
Use `--suite YOUR.robot` for a targeted flow. A timeout stops observation; it does
not cancel or prove rejection of an already-dispatched action.

When fixing a failure, retain its evidence and add the smallest meaningful local
regression before the fix. Test pending results and changed bindings, not just a
steady page. Run the affected flow before broad application acceptance. Report
which checks actually ran, skips, measured times and remaining limits.
