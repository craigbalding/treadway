# Browserless support: design and implementation scope

Let an operator supply their self-hosted or cloud Browserless URL and run existing
Treadway flows remotely. Several projects and concurrent runs can use the same
instance without sharing browser state or interfering with each other's cleanup.

Fresh sessions, selected saved state and explicit borrowed attachment are
implemented. Explicit same-generation reconnect is also implemented. Fresh/state paths have passed checks against Browserless OSS
2.63.1 as a local npm service; borrowed attachment has passed through a real
Chromium relay; reconnect uses a relay that emulates the provider extension.
Provider persistence uses an explicit Session API lifecycle; its control-plane
contract is emulated in tests and Chromium profile restarts are checked directly.
Hosted Session API behavior remains unverified. See the
[usage guide](REMOTE-BROWSERS.md) and [acceptance record](reference/BROWSERLESS-ACCEPTANCE.md)
for current commands and the limits of those results.

## Operator experience

Proposed `browser.json`:

```json
{
  "browser": {
    "provider": "browserless",
    "endpoint_env": "TREADWAY_BROWSERLESS_URL",
    "mode": "fresh",
    "acquire_seconds": 15,
    "session_seconds": 300
  }
}
```

The operator supplies the complete URL through that environment variable, using
their normal secret configuration. Accept `http`/`https` instance URLs by changing
only the scheme to `ws`/`wss`; preserve the path, query and authentication. The URL
must address the service's Chromium CDP launch endpoint. No route guessing or
cloud-specific hostname requirement.

Select this configuration when executing a provider-aware flow. Proposed runner
command:

```sh
python run.py test --browser-config browser.json --suite YOUR.robot
```

Its application bindings must be reachable from the remote browser. The proposed
provider integration resolves the URL and acquires the browser only during
execution. Constructors,
`check` and Robot dry-run stay offline. `acquire_seconds` bounds acquisition;
`session_seconds` caps the local session lifetime and cannot extend the service's
own limit. It also cannot guarantee remote expiry if the service has no finite
timeout; cleanup may remain unconfirmed after a lost connection.

Flows using the provider interface keep their application keywords. Adapters
that launch Chrome directly must first switch to that interface.

Two projects can use this identical configuration and the same service token.
Treadway automatically creates their project IDs in local ignored state and a
fresh ID for each run. No manual tenancy registration is needed.

## Session and ownership decisions

- **Keep one connection per actor for the run.** A run-owned worker holds the
  upstream connection while individual operation processes come and go. Reusing
  a launch URL for every step could create different browsers.
- **Start with fresh state.** Each actor gets its own browser allocation, empty
  context and exact page target. Two concurrent runs using the same actor name
  still get separate state. Browserless capacity use is one slot per active actor.
- **Scope all access.** Handles bind project, run, actor and generation to the
  owned context/target. Cookie export, storage and capture respect that scope;
  labels or shared credentials never establish ownership or actual login identity.
- **Clean up only owned resources.** Dispose the exact owned context and close
  its connection. Never enumerate or terminate unrelated sessions, clear a shared
  profile, or change instance-wide settings. Cleanup has its own recorded result.
- **Bound contention and preserve uncertainty.** A full instance produces a
  bounded wait or a structured failure. Partial acquisition releases only that
  run's resources. Lost connections retain uncertain actions for reconciliation;
  they do not trigger a new browser or mutation replay.

Browserless normally ends a launched browser when its connection drops; its
reconnect and persistence features have separate contracts. The worker preserves
continuity without requiring those extensions. See [Browserless session management](https://docs.browserless.io/baas/session-management).

## First release and follow-on work

Start with fresh Chromium sessions, existing forms/widgets, screenshots and
identity checks. Keep local browser APIs working. Validate the same flows through
an installed package and a pinned self-hosted Browserless deployment; verify cloud
behavior separately before claiming it.

Saved-state reuse, borrowed sessions and reconnect use explicit capabilities.
Persistent identities need exclusive access to the actual remote profile/session,
including when different projects refer to it. Multi-host writers need a real
shared coordination mechanism; a local lock cannot provide that guarantee.

Remote browsers also have different network and filesystem access. The operator
supplies reachable application URLs. Local file uploads/downloads must refuse
before dispatch until a remote transfer adapter is supported.

The [implementation reference](reference/BROWSERLESS.md) defines connection
routing, secret handling, persistence, failure states, module changes and the
concurrent-project acceptance tests.
