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

### Shared development checkout

An editable install is useful for library development: new processes can read
source edits without rebuilding a wheel. It does not freeze a running flow.
A later Python import or Node child can read changed code during that flow.

For collaborating agents, keep one authoritative shared checkout and use an
integration that adopts immutable execution generations. Treadway supplies the
local filesystem and process-lease building blocks in `treadway.generations`:

- `Source` explicitly selects source paths; dependency and local cache folders
  are excluded from source capture.
- `GenerationStore.capture` publishes a content-addressed copy only after source
  verification. `adopt` records it atomically after the consumer provisions and
  checks its runtime.
- `current` refuses new work when authoritative source differs from the adopted
  generation. Updating is explicit; ordinary edits need no distribution build.
- `execution` creates a process-scoped lease. Its returned environment belongs
  only to the flow and descendants. `pinned` validates the original live owner;
  nested helpers must propagate that lease, rather than minting a replacement.

The integration runs library imports and helper scripts from the captured tree,
using one selected Python and Node runtime. It must also snapshot its consuming
helpers and preserve dependency environments used by active generations. Changed
Python metadata or Node locks should create a new dependency cache, rather than
upgrade the active one. Browser binaries and Node are separately installed.
Source mounts can remain read-only; writable generations and caches belong in
each consumer's private runtime directory.

A minimal local capture/adoption looks like this:

```python
from pathlib import Path
from treadway.generations import GenerationStore, Source

sources = {"library": Source(Path("/shared/treadway"),
                             ("src/treadway", "pyproject.toml", "README.md"))}
store = GenerationStore(Path.home() / ".local/share/treadway/generations")
generation = store.capture(sources)
# Provision and verify this generation's dependencies before adoption.
store.adopt(generation, sources)
# At flow start, current() checks the authoritative source again.
generation = store.current(sources)
with store.execution(generation) as execution_environment:
    # Pass this environment only to children using the captured code tree.
    # It also disables source-tree bytecode and isolates cache lookup per flow.
    pass
```

This API performs local capture and lease validation; the consumer integration
owns command dispatch, dependency provisioning and bounded process cleanup.
Do not export a flow pin into a shell, reuse it for unrelated work, or silently
fall back to a release when development source is absent. Missing source blocks
new development work; an already pinned flow reads its existing snapshot.
Keep owned-browser cleanup available independently of source freshness.

Keep release validation on the built wheel, whose packaged assets can differ
from a checkout. Published-package users do not need shared development source.
