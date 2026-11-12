# Walkthroughs: plan a work item, hand it off, and refuse a stale edit

These examples model an onboarding coordinator's work: create a request, assign
an owner, schedule it, write instructions and later hand it to another person.
They run against the small workboard shipped with Treadway, using synthetic
people and SQLite persistence. The original workboard has no authentication. Its
browser input, asynchronous picker, save requests, revisions and reloads are real.

For actual distinct principals and anonymous users, follow
[the collaboration and session walkthrough](SESSIONS.md). Its separate fixture
routes use synthetic accounts and real HttpOnly browser-session cookies.

Humans can follow the steps below; agents can use the same files and returned
bindings. The walkthroughs explain the executable suites rather than define a
second workflow format.

## Set up and find the moving parts

With Treadway, its Robot extra and locked Node runtime installed as described in
[the authoring guide](AUTHORING.md):

```sh
treadway new onboarding
cd onboarding
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite handoff.robot
```

`check` starts no app or browser. Each `test` starts its own isolated loopback app
and Chromium, uses fresh persisted state and performs scoped cleanup. The default
overall budgets are 15 and 60 seconds. Set `CHROME_BIN` to your actual executable.
The runner prints a new private artifact directory for each invocation.

Start with `flow.robot` or `handoff.robot` for the human-readable task. Follow a
keyword to `adapter.py` for domain checks and independent observations, then to
`browser.cjs` for page mappings composed from shared Treadway operations.
`app.py` and `app.js` define the reference application, not a production adapter.

## 1. Create, assign and schedule a request

The first test in `flow.robot` is:

```robot
${item}=    Create Work Item    Synthetic onboarding request
${plan}=    Prepare Work Item Plan    ${item}    Casey Rowan    2026-12-07    2026-12-11    Please prepare the synthetic onboarding materials.
${saved}=    Commit Work Item Plan    ${plan}
Reload And Verify Work Item    ${saved}    ${plan}[expected]
```

Creation uses the browser and observes the actual create response. `${item}`
contains the returned resource ID, run scope, actor, revision and persisted fields.
Subsequent operations use this issued binding; they do not find a resource again
by a similar title or manufacture its ID from intended inputs.

Preparation searches for Casey, waits for that query's actual result and selects
the exact person ID through `Autocomplete`. A visible old matching label is not
enough. `DateRange` enters ordered ISO dates, and `RichTextEditor` inserts the
literal note. `PreparedEdit.bind` captures the complete prepared values without
typing them again. Preparation has not yet saved the plan.

Commit rechecks the issued resource/revision, actual selected owner, prepared
values and native form target. `RequestObserver` attaches before one save action.
The adapter requires the expected response, then independently reads the stored
resource through the application's API backed by SQLite. `${saved}` is the new
binding with the updated revision.

Reload opens a fresh document and checks the displayed fields again, followed by
another persistence observation. This distinguishes typed values, a click receipt,
an HTTP response and a plan that actually survived reload. The example's
`${plan}[expected]` was built from explicit requested inputs; response values do
not define their own correctness.

To change this scenario, supply different explicit owners, dates and notes. Keep
the returned bindings intact and retain the independent checks. Inspect the
actual page before changing its application mapping.

## 2. Hand the same item to another owner

`handoff.robot` extends the ordinary journey. It creates one item, plans it for
Casey, verifies it, then prepares a second plan using the latest binding:

```robot
${sam}=    Prepare Work Item Plan    ${first}    Sam Morgan    2027-01-11    2027-01-15    Sam: confirm access, run the orientation, and close the onboarding checklist.
${current}=    Commit Work Item Plan    ${sam}
Should Be Equal    ${first}[id]    ${current}[id]
```

Read the full suite for setup and independently authored expected values. The
important transition is `${item}` → `${first}` → `${current}`: the actual resource
ID stays the same while the revision advances after each committed plan.

The suite reloads and verifies both plans, then uses `Verify Work Item` to check
persisted `writes` equals two. That counter is an application observation, not a
DOM field. `Reload And Verify Work Item` checks the UI fields; persisted-only
properties need the independent observer.

Finally, the suite deliberately tries Casey's old plan. A native Robot keyword
contains that attempt followed by `Set Suite Variable`. The attempt fails the
issued-binding guard, so the following step is **NOT RUN**. Another reload and
SQLite observation prove Sam's owner, dates, note and two-write count remain
unchanged. A matching resource ID alone does not make an old revision reusable.

This flow reuses the existing domain operations. Add a new domain keyword when
its intent or required observations differ; a new sequence of calibrated
operations can remain just a new native Robot scenario.

## 3. A competing writer invalidates a prepared plan

The second test in `flow.robot` demonstrates a different stale-state boundary:

```robot
${competing}=    Advance Fixture Revision    ${item}
Run Keyword And Expect Error    *resource_revision_changed_inspect_again*    Commit Work Item Plan    ${plan}
Verify No Plan Write    ${item}    ${competing}[revision]
```

The preceding lines in the suite create and prepare the item. The explicit
synthetic competing writer advances its persisted revision without committing
the prepared plan. The issued Python handle is unchanged, but the fresh resource
guard discovers the conflict before browser dispatch. The observer then proves
zero plan writes at the advanced revision.

This is an unmet prerequisite, not evidence that the server rejected a submitted
plan. A server-rejection trial would need an explicit stimulus operation that
actually sends the intended request, plus its own effect observations. Do not
weaken ordinary-flow guards or silently refresh the binding to make this pass.

## Read the evidence and extend safely

In the printed artifact directory, start with `summary.json` and
`robot/output.xml`. `domain.jsonl` records returned bindings, independent
observations and cleanup; `attempts.jsonl` retains action/input and request
observations. The retained SQLite database lets you inspect persisted fixture
state. Successful teardown observes absence and the runner confirms an empty
database; failed workflow and cleanup outcomes remain separate.

For the next flow, state its actor, starting state, explicit inputs, required
persisted fields, meaningful failure and cleanup obligation. Reuse a verified
checkpoint only after rechecking its current binding. Turn a failure into a
small local contract first, then run the affected suite. See
[the recipes](RECIPES.md) for mapping a new component and
[the authoring guide](AUTHORING.md) for observer visibility and intentional input
variations. Keep application-specific selectors and semantics in the consumer.
