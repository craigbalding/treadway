# Browserserve acceptance and deployment

Use the [task guide](../../src/treadway/authoring/skill/treadway-flows/references/BROWSERSERVE.md)
for flow authoring. This reference records what the adapter checks and how to
repeat the real-service acceptance without a hosted account.

## Tested service

- Published `browserserve 0.1.23`, shipped Chrome `154.0.8037.92`.
- Image: `ghcr.io/browser-gateway/browserserve@sha256:c533e7b400e52802d08e53a6fa61f38b1f839d34cc0df10a3f56d3c48ae7251b`.
- Upstream seccomp profile from source revision
  `132d98ada8481abd7014b6c8cc9f1779584c5586`, SHA-256
  `71621cf097776a0b398676e3ac7f5471be8e0c666d343bf8592e79ef320fa9a3`.

The image lacks an OCI source-revision label. Its reported version and immutable
image digest identify the tested artifact; the exact service source commit is
not independently established by the image metadata.

## Run the checks

The fast loop uses only local protocol fixtures:

```sh
npm run test:browserserve
python -m pytest -q tests/test_browserserve_runtime.py tests/test_browser_receipts.py tests/test_authoring_receipts.py
```

For real acceptance, first obtain the image above and the pinned upstream
`docker/seccomp.json` from the public [Browserserve repository](https://github.com/browser-gateway/browserserve).
Then run:

```sh
python scripts/test_browserserve_docker.py --seccomp /path/to/browserserve/docker/seccomp.json
```

This command never pulls or replaces the image. It creates one randomly named
container with no network, no privileged mode or added capabilities, the upstream
seccomp profile and a synthetic application inside it. It requires Node 22+ and
installed npm dependencies. Use `DOCKER_HOST` or `--docker-host` for a non-default
Docker daemon. The command stops and removes only its own container and retains
private evidence in the printed directory, including on failure.

To verify installed package boundaries as well, install the wheel and its Robot
extra in a separate environment, install its browser npm dependencies, and add:

```sh
python scripts/test_browserserve_docker.py --seccomp /path/to/seccomp.json \
  --python-executable /path/to/venv/bin/python \
  --browser-root /path/to/venv/lib/python3.13/site-packages/treadway/browser
```

Replace the example environment paths for your installation. The interpreter,
stdlib, environment and browser module directory are mounted read-only as test
helpers; the service keeps its shipped binary, Chrome, libraries and entrypoint.
The installed Python check restores a selected saved identity in a fresh browser,
then exports and runs the Robot handoff example against the real service.

## Verified behavior

The native service acceptance checks three concurrent actors across two projects
sharing one service endpoint and credential. It verifies separate browser
processes, application users, cookies and storage. Two last-client drops resume
the original process, target, JavaScript heap, unsaved input, HttpOnly cookie,
localStorage, sessionStorage and IndexedDB; another project's session stays usable.

A deliberately unanswered write is independently observed once by the app. After
resume it remains unknown, normal driving is blocked and it is never replayed.
Capacity refusal cannot replace an actor. Explicit release closes each owned
browser; running and parked session counts must reach zero without waiting for
the five-second resume window. The service reports sandbox required, and the
observed browser command line must omit `--no-sandbox`.

Protocol regressions additionally cover malformed/missing resume headers, target
and user changes, missing close replies, expired/refused capabilities, a delayed
park followed by explicit retry, one total cleanup budget, and late pre-resume
CDP responses. Actor-owned command IDs continue increasing across reconnects and
stay below the provider's reserved cleanup-command range.

## Deployment qualifications

The local rootless/vfs Docker environment needed writable runtime mounts:
`/home/runtime` and `/var/lib/browserserve` as uid/gid 999 mode 700, and `/tmp` as
mode 1777. Default runtime storage first failed with a session-directory
permission error. The acceptance runner supplies these tmpfs mounts; it does not
weaken Chromium's sandbox. Its 180-second container-preparation budget accommodates
copying Chrome layers with vfs. This does not establish a universal image defect
or require tmpfs for every deployment.

Browserserve 0.1.23 can end a normally closed WebSocket without acknowledging its
Close frame. An EOF is therefore insufficient cleanup proof. The adapter reuses
Treadway's owned-browser shutdown primitive: a `Browser.close` response followed
by transport closure, only after native session ownership is established.
Missing replies remain unconfirmed. Context disposal, provider-session closure
and unknown application effects remain separate facts in live and offline
receipts.

The local daemon exposes read-only cgroup v1, so the observed isolation tier was
killpg plus RSS polling. Delegated cgroup v2 limits, restart recovery, saved
provider profiles, service persistence across a container restart and load
capacity are outside this acceptance. The test fixes admission pressure thresholds
at 100% to avoid unrelated host load changing its controlled three-session
capacity test; this is a fixture setting, not a deployment recommendation.

Raw evidence includes resume credentials and IPC capabilities and must stay
private. CI uploads only the explicit `ci-summary.json` allowlist. Screenshots,
raw journals, complete resume endpoints and worker capability files are retained
locally rather than published as CI artifacts.
