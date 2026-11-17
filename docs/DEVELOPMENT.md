# Shared development runtimes

Use this reference when building an integration that shares actively edited
Treadway source between agents. For a normal install, follow [installation](INSTALLING.md).

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
