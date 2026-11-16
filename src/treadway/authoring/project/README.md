# Your Treadway flow project

Build high-assurance web workflows: carry out work as the intended user, enforce
current prerequisites and retain evidence that the requested effects persisted.
The same operations also support testing application behaviour and refusals.

To optimise a proven flow for the operator's objective and required assurance, follow
[objective-directed optimisation](.agents/skills/treadway-flows/references/OPTIMISATION.md):

```sh
python optimise_flow.py --describe
python optimise_flow.py --bindings 100
CHROME_BIN=/absolute/path/to/chromium python optimise_flow.py --objective validation
CHROME_BIN=/absolute/path/to/chromium python optimise_flow.py --benchmark
```

Persistence uses a journalled HTTP operation; editor validation retains the UI.
The benchmark explicitly executes separate cold/warm baseline and candidate
transactions, records reuse costs and checks the operator's required evidence.

This runnable reference uses a synthetic local workboard. It creates a work item,
selects an owner by actual ID, enters dates and a literal note, commits against a
revision, then verifies SQLite persistence and a fresh browser reload. A second
case proves a stale revision prevents a plan write. `handoff.robot` adds a
same-item reassignment/rescheduling journey, exact persisted write counts and
proof that a stale handle stops the following native Robot step. Each run cleans only its own
actual resources and verifies absence.

`collaboration.robot` adds actual authenticated A/B handoffs, self-approval
refusal, private-resource access by another principal and two anonymous sessions.
See [the session guide](.agents/skills/treadway-flows/references/SESSIONS.md).
Its `identities.json` contains credential references and expected principals.
The fixture runner supplies deliberately synthetic environment values; Robot's
native `Secret` values pass into the explicit login keyword. For real sources,
follow [credentials and optional vaults](.agents/skills/treadway-flows/references/CREDENTIALS.md).

Requires the supplied Treadway wheel with `[robot]`, its locked Node dependencies,
Python 3.11+, Node 22+ and Chromium. Preserve proxy and CA settings.

```sh
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite handoff.robot
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

Follow [the walkthroughs](.agents/skills/treadway-flows/references/WALKTHROUGH.md)
for an explanation of each executable scenario and its evidence.

Start with [the authoring guide](.agents/skills/treadway-flows/references/AUTHORING.md),
then [the recipes](.agents/skills/treadway-flows/references/RECIPES.md). The agent
skill is [SKILL.md](.agents/skills/treadway-flows/SKILL.md). Installed references
are also available through `python -m treadway.authoring guide start` and `guide recipes`.

Add a `.robot` file using existing keywords. Extend the adapter only for missing
operations. Run `python run.py check`, then `python run.py test --suite YOUR.robot`
with `CHROME_BIN` configured. Default whole-run budgets are 15 and 60 seconds.
All evidence stays in private ignored `artifacts/` directories; failures are retained.
The original workboard is unauthenticated; collaboration routes use synthetic
fixture accounts and HttpOnly session cookies. This is not a production deployment.

`session_recovery.robot` demonstrates 100 REST mutations, application-session
expiry, one refresh and a lost-response reconciliation. It needs no browser:

```sh
python -m robot --pythonpath . --outputdir artifacts/recovery session_recovery.robot
```

Read [the recovery guide](.agents/skills/treadway-flows/references/SESSION-RECOVERY.md)
and `session_recovery.py` together. Its application-owned callbacks identify
renewal, verify the actual HTTP principal and independently inspect SQLite
persistence. Native Robot supplies the loop; completed bindings are not repeated.

For live machinery diagnostics and per-run statistics, run:

```sh
python debug_recovery.py --level DEBUG
python debug_recovery.py --simulate-contract-change-at 38
```

The second command explicitly changes the synthetic app's schema contract and
stops before write 38. Read [the diagnostics guide](.agents/skills/treadway-flows/references/DIAGNOSTICS.md)
for terminal/JSON/Robot sinks, statistics, watched implementation changes and
read-only reconciliation after an uncertain action.
