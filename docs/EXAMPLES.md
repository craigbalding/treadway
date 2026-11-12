# Guided examples

The [packaged walkthroughs](../src/treadway/authoring/skill/treadway-flows/references/WALKTHROUGH.md)
teach Treadway through executable workboard scenarios:

1. Create an onboarding request, select its actual owner, schedule it and verify
   that the plan survives reload.
2. Hand the same item to another owner, change its schedule/note and independently
   verify exactly two persisted writes.
3. Introduce a competing revision and prove a stale plan cannot overwrite it.
4. Create as A, refuse A's self-approval, approve as B and observe as A.
5. Give A's private resource ID to B and two anonymous sessions and verify actual
   application refusals with positive controls and independent state checks.

Each walkthrough explains the Robot steps, returned bindings, shared browser
operations, independent effect observations and cleanup. The examples use the
synthetic app shipped in the package and run without another repository.

```sh
treadway new onboarding
cd onboarding
python run.py check
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot --suite handoff.robot
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

Use `treadway guide walkthrough` to read the same guide from an installed wheel.
The exported `.agents/skills/treadway-flows/` gives agents the same walkthroughs
and authoring references. See [setup and authoring](AUTHORING.md) and
[the feedback loop](FAST-FEEDBACK.md).
The [session guide](BROWSER-SESSIONS.md) explains the actor examples and APIs.
