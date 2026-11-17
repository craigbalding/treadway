# Run a guided example

After [installation](INSTALLING.md), export the examples to a new directory:

```sh
treadway new onboarding
cd onboarding
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot
```

Expect two passed Robot cases. Each browser run starts its own local app and
fresh browser profile, then cleans up its records. The printed artifact path
contains the logs if a check fails.

| Learn to… | Suite | Explanation |
| --- | --- | --- |
| Create, assign, schedule and verify after reload | `flow.robot` | [Create and schedule](../src/treadway/authoring/skill/treadway-flows/references/WALKTHROUGH.md#1-create-assign-and-schedule-a-request) |
| Reassign the same item and refuse an old binding | `handoff.robot` | [Hand off the same item](../src/treadway/authoring/skill/treadway-flows/references/WALKTHROUGH.md#2-hand-the-same-item-to-another-owner) |
| Stop a stale edit before saving | `flow.robot` | [Competing revisions](../src/treadway/authoring/skill/treadway-flows/references/WALKTHROUGH.md#3-a-competing-writer-invalidates-a-prepared-plan) |
| Work as A, B and anonymous users; check permission refusals | `collaboration.robot` | [Separate sessions](BROWSER-SESSIONS.md) |
| Continue 100 mutations across expiry and a lost reply | `session_recovery.robot` | [Session recovery](SESSION-RECOVERY.md) |

For another browser suite, replace `flow.robot` in the command above. The recovery
suite needs no browser; its guide gives the direct Robot command.

Use `treadway guide walkthrough` for the installed explanation. To map your own
application, continue with [authoring](AUTHORING.md).
