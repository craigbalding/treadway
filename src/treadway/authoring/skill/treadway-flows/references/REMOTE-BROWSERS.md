# Choose a remote browser

Use **Browserserve** for new remote deployments. Its native resume capability
keeps the same running browser, page, cookies, JavaScript memory and unsaved
input after a lost connection. Treadway captures that capability at acquisition
and keeps each project, run and actor separate even when they share credentials.

| Provider | Start here | Recovery |
| --- | --- | --- |
| Browserserve (recommended) | [Setup and reconnect](BROWSERSERVE.md) | Resume the same live browser; no preparation step |
| Browserless | [Setup and capabilities](BROWSERLESS.md) | Deployment-dependent extension; explicit preparation |
| Local Chrome | [Session guide](SESSIONS.md) | Owned local process and optional profile |

Choose the provider explicitly in configuration. An existing Browserless URL
must keep `provider: "browserless"`; Treadway does not guess providers or switch
services on failure. Without remote configuration, the local example still uses
local Chrome.

Both remote providers use the same `BrowserRuntime`, shared page operations,
private worker receipts, saved login snapshots and screenshots. The remote
browser needs its own route to the application. Keep your proxy and CA settings;
remote browser launch options belong to the service operator.

Reaching the original browser does not resolve an unanswered action. Inspect its
receipt and independently reconcile the effect before deciding what to do next.
Neither provider replays commands or replaces a refused session automatically.
