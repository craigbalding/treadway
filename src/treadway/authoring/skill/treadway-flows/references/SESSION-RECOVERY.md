# Maintain authentication during repeated mutations

Use `treadway.recovery.OperationExecutor` when a flow needs the same authenticated
principal across repeated REST mutations. It executes **one immutable operation
per call**. A native Robot `FOR` or ordinary Python loop supplies the bindings;
Treadway does not add a scheduler or infer a login mechanism.

## Run the complete local example

After `treadway new my-flow` and `cd my-flow`:

```sh
python run.py check
python -m robot --pythonpath . --outputdir artifacts/recovery session_recovery.robot
```

This example needs the Robot extra, but no browser or external service. It starts
a disposable loopback application, creates 100 distinct SQLite records, expires
its application session after write 37, and uses its declared application refresh
endpoint once. Write 63 commits but loses its response. An independent SQLite
observer confirms that effect, so it is never repeated. Repeating completed
binding 38 returns its recorded receipt without another request. Final assertions
require exactly 100 writes, 100 distinct persisted bindings and one renewal.

Read `session_recovery.py` alongside the Robot suite. Its constructor and Robot
dry-run are passive. `Open Recovery Example` explicitly starts its server. The
suite stops that server; synthetic records and private receipts remain under the
run's artifact directory. Real application bindings belong in the consumer.

## Configure the owner, not a universal fallback sequence

An identity provider's tokens and SSO cookies are distinct from an application's
own session/access/refresh credentials. Either layer can expire independently.
The application might accept an IdP access token directly, maintain a separate
cookie, or keep its upstream refresh tokens entirely on its server. Refreshing
Entra therefore does not inherently renew application authentication.

`AuthenticationOwner` supplies the application's supported mechanisms:

| Callback | Contract |
| --- | --- |
| `prepare(session, context)` | Acquire usable authentication through its owner, normally the existing SDK/cache. Called before each binding when maintenance is enabled. |
| `renew(session, context)` | Handle a recognized authentication loss using only configured refresh/SSO/login mechanisms. Never invent an endpoint or switch accounts. |
| `reconcile(session, context)` | Resolve a previous pending/unknown owner callback using its SDK/cache/provider evidence. `context.previous` identifies that original invocation. Never blindly replay a consumed rotating refresh token. |
| `classify(failure)` | Return exactly `True` only for the application's recognized authentication-loss signal on a failed prerequisite probe. Unknown evidence, wrong principal and ordinary authorization denial are not renewal triggers. |
| `after_probe_headers(observation)` | Optionally materialize declared volatile headers, such as a CSRF value rotated by the probe. Cannot change Authorization, Cookie or immutable mutation semantics. |

Owner callbacks return `AuthenticationResult('ready', 'application_refresh')`, or
an explicit `interaction_required`, `unavailable`, `rejected`, or `unknown` result.
Use a nonsecret mechanism label; keep private evidence in `evidence`. An unknown
callback outcome blocks subsequent credential acquisition until the configured
owner reconciles it. Per-invocation archives retain the original failure.

`context.allow_interactive` states whether the application callback is allowed
to prompt or submit credentials/MFA. It must respect that permission; returning
`interaction_required` does not itself authorize a login. Transient failures
must not escalate automatically to credential submission.

The owner owns renewal timing. Use its SDK's token acquisition/near-expiry policy;
do not add a competing token cache, guessed JWT expiry or background keepalive.
Access-token expiry need not invalidate an independent refresh token. Proactive
renewal is useful only with trustworthy lifetime information and an appropriate
test policy. Refresh can fail early through revocation or policy changes.

## Compose one calibrated operation

The executable example supplies all callbacks. A consumer's domain library uses
the same API with its own established application mappings:

```python
from treadway.recovery import OperationExecutor, RecoveryPolicy

executor = OperationExecutor(
    http_session, private_operation_directory,
    probe="/api/session", expected={"user.id": expected_user_id},
    owner=application_authentication_owner,
    assess=observe_response_and_persisted_effect,
    reconcile=reconcile_original_operation,
    prerequisite=check_original_resource_revision,
    policy=RecoveryPolicy(maintain_authentication=True, max_renewals=1,
                          max_dispatches=2, allow_interactive=False),
)

receipt = executor.execute(
    operation_id, "/api/items", method="POST",
    body=original_payload, binding=original_resource_binding,
    headers={"If-Match": original_revision},
    idempotency_key=stable_application_supported_key,
)
```

The names in this fragment are application bindings, not built-in helpers or
assumed routes. Omit `idempotency_key` if the application has no such contract.
Never add a key and assume that the server enforces it.

Record a stable operation ID for each binding before execution. Intent pins actor,
origin, expected principal, probe policy, owner scope, method/path, exact JSON
body, binding, semantic headers and optional idempotency key. Changed input,
`If-Match`, resource revision or key is refused when the same ID is resumed.
Authentication renewal never repairs those values. Credential headers and declared
volatile CSRF headers belong to the session/owner, outside semantic intent.

The principal probe and mutation use one credential-header acquisition; semantic
mutation headers do not go to the probe. Cookies updated by the probe are retained.
Declared post-probe CSRF materialization happens before the application prerequisite
and internal durable dispatch reservation. The actual mutation is dispatched once
per authorized attempt. `HttpSession.request` itself never renews or retries.

## Decide effects separately from renewal

`assess(operation, observation_or_failure, session)` returns an `Assessment` backed
by application response and independent effect evidence. Its outcome is
`confirmed`, `rejected`, or `unknown`. A successful status alone does not prove the
intended business effect. `authentication_required=True` may authorize bounded
renewal for further observation; it does **not** authorize repeating the mutation.

`reconcile(operation, previous_private_record, session)` observes the original
operation. It may establish completion or definitive rejection. When another
attempt is justified, its replay permission must be explicit:

- `replay='not_applied'`: an authoritative application contract proves no effect
  occurred. An empty eventually-consistent query is insufficient.
- `replay='idempotency_valid'`: the server guarantees safe repetition of this
  exact principal, endpoint, payload and key. Supply `replay_until` as a UNIX
  expiry time derived from that contract. Permission is rechecked before each
  replay, and the remaining window must cover the mutation's request budget.

A current attempt's rejection cannot clear an earlier unknown effect. A crash
between server commit and recording completion retains that uncertainty. Without
valid reconciliation or replay permission, execution stops and keeps it unknown.
Renewal can still run to permit read-only reconciliation, without sending another
mutation. Returned confirmed/rejected receipts are historical observations; they
are not fresh assertions about today's application state.

## Transport state, isolation and coordination

Browser authentication and an HTTP replay session are separate. If browser login
or SSO is the configured recovery mechanism, preserve the owned browser, export
complete required state, atomically import its bound cookie snapshot, obtain any
required bearer/CSRF state, then verify the principal through the **HTTP client
that will mutate**. A browser success alone is insufficient. Never overwrite a
newer HTTP jar with an older browser export by guesswork. The application must
define the state owner and synchronization direction. See [sessions](SESSIONS.md)
and [Entra](ENTRA.md).

All cooperating consumers of a credential grant must use the same owner `key`
and private owner directory. The file lease spans preparation, probe,
materialization and dispatch. Its scope is the actual client/grant, not merely
an identity label. Lock order is operation journal → authentication owner → HTTP
session. Reentrant session use inside `prerequisite` is refused; use a separate
read-only observer. Unrelated browser or SDK activity is outside these locks and
must be coordinated by that owner. Different owners/identities remain separate.

Directories are private (0700), records private (0600), and updates atomic with
file and containing-directory fsync for process-crash recovery. Newly created
ancestor directory entries are not separately synced; this is not a guarantee
against filesystem or power loss. Linux process-shared file locking matches
Treadway's browser environment.
Normal receipts and `OperationIncomplete.receipt` contain status/counts/code and a
private evidence path. `executor.read_evidence(operation_id)` explicitly exposes
raw private request intent and bounded response headers/bodies, which can include
cookies and personal data. Never print that result or return it through Robot.

`HttpFailure` preserves phase, dependent action dispatch, principal interpretation
and the private failed observation. `not_started` means the mutation was not
handed to the transport. `possibly_started` deliberately does not claim socket
failure proves rejection. Browser actor failures similarly retain the failed
probe, including available status and partial body.

## Explicit policy and limits

Maintenance is off by default. `RecoveryPolicy(maintain_authentication=False)`
still performs the explicitly requested principal probe. Only
`verify_principal=False` suppresses that probe, for intentional anonymous/expiry
conditions. Enable neither maintenance nor incidental probes during a deliberate
idle-expiry test; probes may extend sliding sessions.

`credential_headers` must only materialize the credential snapshot prepared by
the owner. Do not refresh tokens inside it: hidden renewal would bypass the
maintenance policy and the owner's recorded callback boundaries. Keep SDK refresh
in `prepare` or `renew`, under the shared owner lease.

Renewal and dispatch budgets persist across operation restarts. Each HTTP request
has its own bounded timeout. Authentication callbacks receive a cooperative
monotonic deadline and must apply it to SDK/network work; a late result cannot
permit the next mutation. Arbitrary in-process callbacks cannot safely be forcibly
cancelled. For hard overall deadlines, run the flow/provider in
`run_json_process` or another owned bounded process. Application classification,
prerequisite and effect-observer callbacks must themselves be bounded; no hidden
thread or second scheduler enforces their wall-clock time.
