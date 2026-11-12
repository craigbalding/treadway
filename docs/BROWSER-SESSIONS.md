# Browser and actor sessions

The [installed session guide](../src/treadway/authoring/skill/treadway-flows/references/SESSIONS.md)
documents Chromium lifecycle, sandbox and proxy choices, profile persistence,
exclusive session control, actual-principal verification, isolated HTTP cookie
jars, origin state operations and scoped CDP target monitoring.

## Chromium sandbox in gVisor

Sandboxed Chromium startup and Treadway's generated example flow have both been
verified in a SafeYolo environment using gVisor, with user namespaces enabled.
Keep the sandbox enabled by default, including under gVisor. Running under
gVisor alone is not a reason to pass `--no-sandbox`, set `sandbox=False` or set
`TREADWAY_CHROME_SANDBOX=off`.

If startup fails, inspect the retained Chrome log named in the error. A startup
timeout alone does not establish a sandbox failure. Diagnose the actual browser
or runtime error before changing sandbox settings. See the installed
[sandbox guide](../src/treadway/authoring/skill/treadway-flows/references/SESSIONS.md#chromium-sandbox-in-gvisor)
for the explicit opt-out in an environment that demonstrably cannot support it.

## Collaborative walkthrough

Use `treadway guide sessions` from an installed package. The shipped
`collaboration.robot` walkthrough exercises distinct authenticated principals and
two anonymous sessions through actual browser requests and independent persisted
state observations. Run it after `treadway new my-flow`:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

Core supplies mechanics. Adapters define their identity probes, resource
relationships, expected permission rules and completion evidence.
