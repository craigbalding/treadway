# Install Treadway

Use Linux, Python 3.11+ and Node 22+. Browser flows also need a separately installed
Chrome or Chromium. Keep your environment's proxy and CA settings. Chromium's
sandbox stays enabled, including [under gVisor](BROWSER-SESSIONS.md#chromium-sandbox-in-gvisor).

## From a GitHub release

Download a wheel from [GitHub Releases](https://github.com/craigbalding/treadway/releases).
Replace the wheel path below with your download:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install '/path/to/treadway-0.2.0-py3-none-any.whl[robot]'
TREADWAY_BROWSER_DIR=$(python -c 'from pathlib import Path; import treadway; print(Path(treadway.__file__).parent / "browser")')
npm ci --ignore-scripts --prefix "$TREADWAY_BROWSER_DIR"
treadway new my-flow
cd my-flow
python run.py check
```

Expect `"passed": true`. The Python wheel includes browser-control JavaScript;
`npm ci` installs its locked `ws` dependency. Repeat that step after upgrading the
wheel. Python installation alone does not install Node or Chrome.

Then [run the browser example](EXAMPLES.md). If Node reports `Cannot find module
'ws'`, check that `TREADWAY_BROWSER_DIR` belongs to the same Python environment
that runs your flow, and repeat its `npm ci` step.

## From a checkout

The [README quickstart](../README.md#try-the-local-example) gives the editable
install and first flow. Library contributors can use `python -m pip install -e '.[dev]'`
to add pytest and Ruff, then follow [fast feedback](FAST-FEEDBACK.md).

An editable install exposes source edits to new processes. For multiple agents
sharing changing source, use [immutable development generations](DEVELOPMENT.md)
to keep a running flow on one version. Release users do not need that integration.
