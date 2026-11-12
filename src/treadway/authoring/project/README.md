# Your Treadway flow project

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
