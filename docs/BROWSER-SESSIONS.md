# Browser and actor sessions

The [installed session guide](../src/treadway/authoring/skill/treadway-flows/references/SESSIONS.md)
documents Chromium lifecycle, sandbox and proxy choices, profile persistence,
exclusive session control, actual-principal verification, isolated HTTP cookie
jars, origin state operations and scoped CDP target monitoring.

Use `treadway guide sessions` from an installed package. The shipped
`collaboration.robot` walkthrough exercises distinct authenticated principals and
two anonymous sessions through actual browser requests and independent persisted
state observations. Run it after `treadway new my-flow`:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

Core supplies mechanics. Adapters define their identity probes, resource
relationships, expected permission rules and completion evidence.
