# Project boundary

Treadway supplies reusable mechanics for agent-directed workflows:

- Form discovery, sourced candidate input, verified readback and explicit actions.
- Bounded subprocess execution with live progress and retained incomplete results.
- Strict comparisons between expected fields and observed application state.
- Explicit-target browser connections and thin Robot Framework bindings.

Application adapters own selectors, routes, request shapes, account and resource
relationships, state observers and completion conditions. They combine calibrated
operations into working flows and establish which intermediate states can be
reused for input variations. Adapters can live in a consuming application or a
separate package. Treadway owns the shared library and optional synthetic
reference projects used to document and exercise its APIs. Those examples ship
with the authoring kit; real-application integrations own their fixtures,
lifecycle orchestration and acceptance records. Installing, developing and
validating Treadway requires no other repository. Public guides teach from the
shipped examples and must be usable without access to an integration's source
or private captures.

Agents choose goals, candidate inputs, meaningful variations and assertions.
Operations pass actual runtime values between steps and enforce their required
conditions. Property comparisons expose matches, differences and unknowns with
observation references; callers supply and justify the expected behavior.

Robot Framework supplies variables, returned objects, keywords, resource files,
setup/teardown and execution reports. Python and JavaScript APIs also work directly.
Treadway does not require a hosted service, model provider or parallel scheduler.

## Operational contracts

An instrumented click establishes interaction observations, not saved or submitted
state. Application completion requires an appropriate observer and an explicit
completion condition. Human input is a checkpoint, not a fabricated completion.

Browser connections require an exact target. Non-loopback connections use an
explicitly configured HTTP proxy, with no direct remote fallback. Environment
setup and result publication belong in the consuming integration. The shared
local Chromium manager owns explicit process/profile/session lifetimes; scoped
target monitoring supplies optional capture mechanics. Application identity and
permission rules stay in adapters. Actor verification must use the same session
as the action, and execution guards must preserve intentional unauthorized attempts.

Keep incomplete results available for investigation. A timeout cannot cancel an
action already dispatched to a browser or server; retry decisions must account
for uncertain effects. Cleanup is explicit and must report its own outcome.

The current implementation is an early library with tested interaction patterns,
not universal application support. See [form capabilities](docs/forms.md) and
[validation and limits](docs/VALIDATION.md).
