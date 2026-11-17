# Browserless acceptance checks

These are separate checks with different claims:

| Check | What it exercises |
| --- | --- |
| `npm run test:browserless` | Deterministic transport, worker, scope, deduplication and uncertainty contracts. No Browserless installation. |
| `npm run test:browserless:browser` | Actual Chromium through a CDP relay, shared-browser context isolation, saved-identity restoration, borrowed-page observation/drive/detach, explicit reconnect, Python bridge/form operations and exported Robot edit/handoff examples. Requires `CHROME_BIN` and installed Python dependencies. |
| `npm run test:browserless:service` | Actual Browserless OSS 2.63.1, its Chromium launch route, scoped saved-state restoration, capacity refusal, lost write response and unrelated-client survival. Requires the separate service installation below. |

On 2026-11-17 the service check passed using the published npm service, Node
24.22.3 and its Playwright 1.65.0 Chromium build. The service ran as an ordinary
local process. This was not a Docker-image test or a Browserless cloud test.
The relay check also passed a saved edit/reload and an author → reviewer → author
approval flow from an exported project without `CHROME_BIN` in the consumer.
The borrowed-page check captures an explicitly visible operator page, refuses
mutation through an observation connection, drives the same page with explicit
permission, and preserves its other pages and unrelated context state. Direct
Chromium probes also observed screenshot timeouts for a long-hidden page; the
adapter does not change focus to manufacture a successful capture.
Saved-state checks restore selected cookies, localStorage and sessionStorage into
a new generation and independently verify the application's actual user.
The reconnect relay emulates only `Browserless.reconnect` and its returned URL.
Actual Chromium preserves the original context, target, cookies and storage;
Python revalidates the application's user before driving resumes. Protocol tests
cover rejected, expired and unobserved preparation replies, changed targets/users,
authority refusal and an unknown write that remains quarantined after reconnect.

## Prepare the pinned OSS service

Use a separate directory and a Node runtime meeting the service's requirements
(Node >=24 and npm >=11.10). Treadway's Node requirement remains >=22.

```sh
npm install --prefix /absolute/service --ignore-scripts --omit=dev @browserless.io/browserless@2.63.1
```

The published tarball's integrity is:

```text
sha512-1ccWa14FEulzEfDwYLZ6rCrxVP2YQMfZqYWF6joMCXFYpcIpLyUWReENYUzYG4GKA11eYJ+5aCiKw3M8p4xuUA==
```

Compare it with the package-lock entry for `@browserless.io/browserless` and
retain that lock for the dependency versions used. Install Chromium with the
service runtime:

```sh
/absolute/node24 /absolute/service/node_modules/playwright-core/cli.js install chromium
```

The npm package's management metadata route resolves `node_modules` relative to
the package directory, which fails with npm's hoisted layout. For that layout,
add a dependency-directory link; this changes no service source:

```sh
ln -s ../.. /absolute/service/node_modules/@browserless.io/browserless/node_modules
```

Run from the Treadway checkout with its Node dependencies installed:

```sh
TREADWAY_BROWSERLESS_SERVICE=/absolute/service/node_modules/@browserless.io/browserless \
TREADWAY_BROWSERLESS_NODE=/absolute/node24 \
  npm run test:browserless:service
```

The opt-in test owns its service, selects an unused loopback port, configures only
the supplied Chromium/management routes and uses disposable authentication. It
preserves the proxy and CA environment. It starts no cloud sessions. Private
logs remain on failure; a passing run removes its temporary service state.

The service's Chromium launcher adds `--no-sandbox` in this release. This is a
provider setting observed in its code, not a Treadway fallback for gVisor.
Treadway's own local browser checks keep Chromium's sandbox enabled.

## Limits of these results

These checks establish the exercised fresh-context and selected-state paths, and
borrowed attachment and reconnect through a real Chromium relay. Browserless's
own reconnect extension, its existing-browser attachment routes and Session
API persistence need their own lifecycle and failure acceptance. Neither the
relay nor the OSS service result establishes those capabilities or cloud
compatibility. Keep that distinction when reporting results for another service
version or deployment.
