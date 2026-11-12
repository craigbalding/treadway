# Installing Treadway

Requires Linux, Python 3.11+, Node 22+ and a separately installed Chrome or
Chromium executable for browser workflows. Preserve your proxy and CA settings.
The Python package ships browser-control code, authoring guides and examples.
It does not include Node or a browser binary.

Keep Chromium's sandbox enabled by default, including under gVisor. Sandboxed
browser startup and the generated example flow have both been verified in a
SafeYolo environment using gVisor. Do not add `--no-sandbox` or set
`TREADWAY_CHROME_SANDBOX=off` just because the runtime is gVisor; see
[sandbox support and startup diagnostics](BROWSER-SESSIONS.md#chromium-sandbox-in-gvisor).

## From a GitHub release

Download the wheel for your version from
[GitHub Releases](https://github.com/craigbalding/treadway/releases). Release
automation is configured; a download becomes available when a version is tagged
and its checks pass. Create and activate a writable virtual environment before
installation. In the command below, replace the wheel path with your download.

The wheel includes JavaScript and a locked Node dependency manifest. In a writable
virtual environment, install the Python wheel with the `robot` extra, then install
the browser runtime's dependency beside those assets:

```sh
python -m pip install 'path/to/treadway-0.2.0-py3-none-any.whl[robot]'
TREADWAY_BROWSER_DIR=$(python -c 'from pathlib import Path; import treadway; print(Path(treadway.__file__).parent / "browser")')
npm ci --ignore-scripts --prefix "$TREADWAY_BROWSER_DIR"
```

Node resolves `ws` from that directory regardless of the caller's working directory.
The checkout-level `npm ci` is sufficient for an editable source installation.
Use `npm ci --offline` when the locked dependency is already cached. Installing a
Python wheel alone does not install Node or its dependencies. Package upgrades
require repeating the runtime dependency installation.


## From a checkout

Follow the [README quickstart](../README.md#try-the-local-example) to install
the Robot extra and locked Node dependencies. For library development, use
`python -m pip install -e ".[dev]"` from the checkout instead; it also installs
pytest and Ruff. Run the [focused checks](FAST-FEEDBACK.md) before broader
acceptance. CI and release gates are documented in [releasing](RELEASING.md).
