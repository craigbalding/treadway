# Credential provider reference

Use [Configure credentials](CREDENTIALS.md) for the working example. This reference covers
configuration, API behaviour and limits.

## Providers

Each provider is selected explicitly; installing one never activates it.

| Configuration type | Reference | Retrieval |
| --- | --- | --- |
| `environment` | `name`: exact variable name; no `field` | Reads the process environment on every explicit call. |
| `1password` | `name`: complete `op://vault/item/field`; no `field` | Runs installed `op read --no-newline` without a shell; captures output privately. |
| `rpa-vault` | `name`: bundle name; `field`: exact bundle field | Uses the selected RPA adapter in an isolated, bounded helper process. |
| `safeyolo-gateway` | `name`: `token`; no `field` | Reads an already-authorized exact service/capability/account binding. |

For Python adapters, construct `CredentialResolver.from_file(path)` and call
`read(identity, field)` only inside the credential-consuming operation. This
low-level method returns a plain string. `identity(name).expected` supplies only
configured expectations for the adapter's actual-session probe. Custom providers
implement `read(CredentialRef) -> str` and are registered programmatically with
`CredentialResolver(identities, providers)`. They must keep values and failures
private and bound their own execution. Shared resolution sanitizes error messages
but cannot undo a custom provider's logging or side effects.

### 1Password

Configure a provider as `{"type":"1password","timeout_seconds":10}` and use a
full secret reference in each credential. An optional `executable` selects the
installed CLI. Authenticate/provision CLI access outside the flow. Treadway never
runs sign-in, changes vault permissions, writes secrets to disk or retries a read.
It preserves exact UTF-8 text, including CRLF, bare CR and other whitespace.
Non-UTF-8 output is rejected. The timeout covers the child
process group on POSIX; provider stderr is not copied into Robot diagnostics.
The returned text is limited to 64 KiB; this is not a bound on all subprocess
output buffering. Use trusted executables and trusted configuration.

Alternatively, use the environment provider and launch a flow with
`op run --env-file private-reference.env -- python run_flow.py`. The file can
contain `REVIEWER_PASSWORD=op://automation/reviewer/password`. This uses
1Password's existing environment injection and needs no Treadway CLI adapter.
See [1Password secret references](https://developer.1password.com/docs/cli/secret-references/).

### RPA Vault

Install the supplied wheel with `[robot,vault-rpa]` to add the optional
`rpaframework` dependency. Its broader package may require native build tools
and Python headers on Linux; core Treadway and other providers do not require it.
Configure `{"type":"rpa-vault","mode":"control-room","timeout_seconds":10}`.
The explicit helper constructs `RPA.Robocorp.Vault.RobocorpVault`, using the normal
`RC_API_SECRET_HOST`, `RC_API_SECRET_TOKEN` and `RC_WORKSPACE_ID` environment.
Provision those privately. There is no hosted-vault bootstrap or permission grant.

For local development, explicitly select
`{"type":"rpa-vault","mode":"file","secret_file":"/private/vault.json"}`.
Relative file paths resolve against the reference configuration's directory.
The upstream `FileSecrets` adapter reads its ordinary JSON/YAML bundle format;
the file is plaintext, must live outside source control, and is never written by
Treadway. Explicit provider selection overrides `RPA_SECRET_MANAGER`; an explicit
file overrides `RPA_SECRET_FILE`, preventing an ambient setting from choosing a
different credential source. Hosted mode never falls back to a local file.
The helper suppresses upstream diagnostic output and returns only the selected
field; its deadline bounds optional-library startup and retrieval. It does not
cache whole bundles in the calling process. RPA's own bundle `Secret` is a
different class from Robot's native wrapper; `CredentialLibrary` returns the latter.
See [RPA Vault documentation](https://rpaframework.org/libdoc/RPA_Robocorp_Vault.html).

### SafeYolo gateway

This optional provider uses SafeYolo's existing broker boundary rather than
reading its host vault. Configure, for example:

```json
{"type":"safeyolo-gateway","service":"workboard","capability":"reader","account":"reviewer"}
```

It reads the agent API token from `/app/agent_token` at explicit resolution time
(or an explicitly provisioned `agent_token_file`) and makes one proxy-mediated
GET to `http://_safeyolo.proxy.internal/gateway/services`. The exact service,
capability and account must already be authorized. No access request, approval,
vault unlock or renewal is attempted. Missing/changed authorization fails closed;
operator provisioning stays outside the flow. No host admin token is used.
The token file must be a regular file, not a symlink or pipe, with at most 4 KiB
of UTF-8 text; it is reread for each resolution.

The returned `sgw_` token is itself sensitive. It is a scoped gateway token, not
the upstream password or proof of an application principal. A Python HTTP adapter
can read it inside its existing `HttpSession.credential_headers` callback and put
it in the service's configured auth header. Preserve proxy/CA environment settings.
SafeYolo enforces delivery and substitutes the upstream credential; Treadway does
not implement or broaden that policy. It does not automatically solve browser
password-form login. A gateway-policy refusal is not evidence that the application
rejected a deliberately unauthorized action.

For a service configured to accept a Bearer token:

```python
from treadway.credentials import CredentialResolver
from treadway.sessions import HttpSession

credentials = CredentialResolver.from_file("identities.json")
reviewer = HttpSession(
    actor="reviewer", origin="https://workboard.example",
    credential_headers=lambda: {
        "Authorization": "Bearer " + credentials.read("reviewer", "gateway_token")
    },
)
# No credentials have been read yet. An explicit request invokes the callback.
```

Here `gateway_token` must be a configured credential referencing the gateway
provider's `token`. The origin/header must match the provisioned service; never
copy an upstream username/password reference into this slot.
