# Authoring kit validation — 2026-11-09

This validates the authoring kit shipped with Treadway 0.1.0. Earlier library and
application acceptance remains evidence for its own scope. The kit introduces no
new workflow language and does not change the shared browser runtime.

## Deliverables and checks

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Discoverable agent skill | `treadway-flows/SKILL.md` with scoped workflow and linked references | Skill validator passed; exported both independently and into a new consumer; also installed under the agent's skill directory |
| Standalone authoring guide | Wheel-bundled `AUTHORING.md`; `treadway guide start` | Installed CLI works from `/tmp`, outside either source repository |
| Recipe index | Wheel-bundled `RECIPES.md`; `treadway guide recipes` | Discovery, choices, editing, requests, dates/plain text, multiselect, transfers, observations and reconciliation routes |
| Scaffold helper | `treadway new DIRECTORY` / `python -m treadway.authoring new DIRECTORY` | Existing files/directories and symlinks are refused; new project exports complete app, adapter, skill, tests and Robot suites |
| Runnable reference project | Synthetic loopback workboard with SQLite persistence | Installed-wheel acceptance: 2/2 Robot cases, all local checks passed, zero remaining items |
| Fast feedback | `python run.py check`; `python run.py test --suite FILE.robot` | Offline check 7.209 seconds, no app/browser; complete installed reference 22.619 seconds; budgets 15/60 seconds |
| Enforced deadline | Overall subprocess deadlines and isolated process groups | Regression deliberately hangs a contract, observes deadline failure and terminated child, and proves no app database/browser was created |
| Fresh agent trial | Independent agent, installed kit only, isolated consumer | Passed; direct audit of native Robot status, actual requests, persisted effects, cleanup and current consumer sources |

The public starting point is [the authoring guide](AUTHORING.md). The packaged
skill's references are the maintained full guide and recipe index; the docs entry
links to them rather than duplicating their instructions.

## Installed-package acceptance

A fresh wheel was built offline using the configured build backend and installed
with its Robot extra under `/tmp/treadway-authoring-installed`. The locked `ws`
dependency was installed beside its browser assets. The initial 31 checked files matched
checkout bytes: the authoring command, 15 authoring assets, all 14 shipped browser
JavaScript modules and `widgets.py`. No source checkout is needed at runtime.

From `/tmp`, the installed `treadway new` created
`/tmp/treadway-authoring-wheel-baseline`. Its `run.py test` passed both cases in
**22.619 seconds**. It exercised actual browser input, asynchronous exact-ID owner
selection, dates, plain-text note, native-form/prepared-edit binding, one correlated
save, independent SQLite readback, new-document reload and observed scoped cleanup.
The fault case advanced the persisted revision through an explicit synthetic
competing writer; the stale plan was refused and the observer proved zero plan
writes. It does not claim a server rejection of a submitted plan.

The separate installed `run.py check` passed in **7.209 seconds**. It performs
Python syntax/contracts, Node contracts/syntax and native Robot dry-run. Missing
prerequisites or failed checks fail the command. It does not skip browser coverage
silently or start an application. Source discovery excludes private artifacts,
virtual environments and Node dependencies.

Final core verification passed **70 Python tests**, **54 Node tests**, configured Ruff,
and both real React/Vue fast browser cases without skips. The six new Python
checks cover export boundaries, a standalone skill, installed guide access,
passive generated-project checks, termination of a deliberately hung contract and
retention/discovery of a newly added failing Node contract.
The original form/widget browser runtime is unchanged by this kit; the two new
reference scenarios are additional installed-package evidence, not a replacement
for prior widget coverage.

## Independent agent trial

An independent agent received only the installed package, Chromium path, generated
consumer skill and a realistic onboarding-handoff task. It had no access to either
source repository or previous consumer copies. Python, Node, Robot and Chromium
were already installed; environment installation is outside these measurements.

The agent built `handoff.robot` using the existing domain keywords, with no new
domain operation or browser driver. It created one actual item, assigned/scheduled
it for Casey, verified it after reload, reassigned/rescheduled the same item for
Sam with a different note, then independently verified exactly two persisted plan
writes. Reusing Casey's old plan refused execution before browser dispatch. The
following native `Set Suite Variable` was **NOT RUN**, and a subsequent reload and
SQLite observation proved Sam's current plan was unchanged. Teardown observed
absence, and the database contained zero remaining items.

| Measurement | Observed result |
| --- | --- |
| Trial start → first new-flow Robot PASS, including teardown | **276.427 seconds** |
| Trial start → first whole-run PASS, including runner cleanup | **276.924 seconds** |
| New-flow offline checks | **4.670 seconds** |
| First new-flow complete acceptance command | **23.453 seconds** |
| First browser subprocess within that command | **17.879 seconds** |
| Seed invocation → first failed ordinary offline check | **3.368 seconds** |
| Seed invocation → first passing check after diagnosis/regression/fix | **129.465 seconds** |
| Affected browser acceptance after correction | **24.427 seconds** |

After the flow passed, an opaque harness seeded a consumer mapping defect. The
agent did not inspect the helper that seeded the defect. The next ordinary offline
check failed. It used the guide and actual app mapping to diagnose a wrong query marker, added a
regression with conflicting query/search markers, retained a second red run, made
one token-level mapping correction and reran the affected browser flow. No test
was weakened and no action retry was introduced.

`acceptance-audit.json` independently checks both successful browser runs against
actual XML, request/observation journals, SQLite and cleanup. The final corrected
consumer source hashes match its final run manifest. The agent's report and
subprocess timing captures are retained. This is one measured task and agent, not
a general benchmark of authoring productivity.

The validated handoff and both new contracts are now shipped with the scaffold.
The final wheel has **32** byte-matched checked files (16 authoring assets plus
the same runtime/command files). The trial also exposed missing structured browser
timing, loss of prior checks on failure and unclear UI-versus-persisted field
coverage. Those gaps were corrected. A new focused regression additionally
showed that an added Node contract file was not discovered; it failed in 5.95
seconds, then passed in 2.95 seconds after automatic contract discovery was added.
The final summaries retain completed, failed and incomplete checks, their logs,
and browser-command duration. The guide explicitly separates UI field reload
observations from persisted-only write counts.

## Final installed-kit acceptance

The same independent agent exported a fresh consumer from the rebuilt wheel and
ran both `flow.robot` and `handoff.robot` together. All **3/3** cases and all six
check stages passed in **36.337 seconds**, inside the default 60-second budget.
The browser subprocess took **31.463 seconds**, now retained in both its check
entry and `browser.commandElapsedSeconds`. A separate final offline check passed
in **3.879 seconds**, within its 15-second budget.

A newly added `tests/final-discovery-probe.test.mjs` deliberately failed the normal
check in **2.002 seconds**. Its structured summary retained the two earlier
passed checks, failed exit code and log path. Removing only that probe restored
green. Final consumer sources are identical to its fresh export, and final
acceptance hashes match those sources. Original trial reports and timing evidence
remain unchanged.

A second direct audit confirmed the actual three Robot PASS results, native
following-step NOT RUN, persisted Sam plan with exactly two writes, all scoped
cleanup outcomes and empty SQLite database. Both the browser and application
ports were closed afterward. `final-acceptance-audit.json` retains that audit.
No remaining material issue was found in this final pass.

Private evidence is retained under the core repository's ignored
`artifacts/authoring-kit-20261109/`: the original and final wheel/build logs,
installed baseline, original independent trial, final installed consumer,
`report.json`, `final-report.json`, timing captures, both acceptance audits and
source-byte audits. Chrome profiles are excluded from the retained copy.
The public handoff example is shipped under `authoring/project/handoff.robot`.
All authoring guide/skill links and both repositories' diff checks passed.

## Retained calibration failures

The first reference browser run failed in **14.382 seconds**: the adapter tried
to locate a listbox option as a page action. It also revealed that recovering
already-cleaned IDs from the journal must observe absence rather than repeat a
DELETE. The corrected adapter uses the raw observed option reference and scoped
read-only cleanup checks; focused local contracts cover both behaviors.

The second run failed in **21.444 seconds** because a returned reload-readback
promise was not awaited before closing the CDP session. Awaiting readback preserves
its lifetime; the complete reference subsequently passed. These failures remain
retained, not reclassified as successful acceptance.

The skill validator initially lacked PyYAML, and an attempted build without
isolation lacked setuptools in the development environment. Installing the
validator dependency with the existing `uv` tool and using the configured isolated
offline build resolved setup. The final wheel build succeeded without the earlier
ambiguous package-data warnings. No runtime dependency was added for the kit.

## Scope

The reference is a small synthetic, unauthenticated workboard. Its explicit actor
marker is an identity-check example, not proof of real authentication. Its browser
client is ordinary JavaScript; existing pinned React/Vue fixtures remain the
framework evidence. External application selectors, authorization, persistence
semantics and rich component kits still require their own adapters and calibration.
The fresh-flow trial measures one agent and one task, not a general productivity
benchmark. Python, Node, Robot and Chromium were installed before trial timing.
