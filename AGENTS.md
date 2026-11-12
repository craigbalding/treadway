# Working on Treadway

Purpose: reliable workflow execution for agents.

- Keep the shared library independent of any application, model provider or
  consuming service. Application-specific integrations belong outside the core.
- Reuse calibrated operations. Distinguish observed facts from expected values,
  proposed inputs and inferred causes.
- Preserve explicit action choices and intentional input variations. Do not add
  implicit retries, account fallback, dialog acceptance or input repair.
- Imports, constructors, dry-runs and offline tests must not contact live applications.
- Preserve incomplete results and uncertain effects. A missing observation does
  not prove absence, and a runner failure does not prove application rejection.
- Enforce prerequisites inside operations that depend on them. Test actual
  composition, including failures that must stop later steps.
- Keep credentials, private user data and runtime captures outside the repository.
  Use clearly synthetic local fixtures in tests.
- Prefer native Robot Framework composition over a second workflow DSL or scheduler.
- Run focused checks for changed behavior. Include browser and installed-package
  checks when changing those boundaries; record skipped checks and known limits.
- Keep a fast feedback loop: reproduce failures in the smallest local contract
  test, then run `test:browser:fast` before expensive application acceptance.
  Model pending results, rerenders and changed bindings, not only steady states.
- Keep public documentation and shipped assets self-contained. Generic guidance and
  synthetic walkthroughs belong here. Do not link or require private/sibling
  source checkouts; application integrations own their acceptance records.
