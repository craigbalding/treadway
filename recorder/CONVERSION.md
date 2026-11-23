# From a demonstration to an HTTP-first Treadway flow

The operator demonstrates the baseline once. The agent translates the evidence
into native Robot Framework composition and small calibrated adapters. Prefer
`treadway.sessions.HttpSession` for application operations; retain browser steps
where they supply required behavior. This is an authoring workflow, not a replay
of every click or a new flow language.

## Assemble the input bundle

Keep the event file, persona facts/generator seed and secret references, intended
role/account, expected outcomes, and exact FlowStore captures together in private
runtime storage. Retrieve captures using each `network_response.safeyoloRequestId`.
Keep redirect/authentication legs and errors, not just the final response. Verify
the stored method, URL, timestamps, context, capture completeness and original
request/response bodies. A response ID does not prove that bodies were retained.

Keep source originals distinct from excerpts or projections. A cached header can
reference a previous capture. A missing/ambiguous ID, unfinished request, failed
content drain or truncated body stays an explicit gap. Use the run context for
discovery, then verify any proposed join rather than guessing by proximity.

## Establish what the demonstration actually proved

Build a short mapping from each intended step to its observed UI events, exact
requests, returned identifiers and independent outcome observation. Mark temporal
UI associations as candidates until request payloads and application behavior
support them. Authentication markers and persona roles describe operator intent;
an application-specific principal response establishes who the actual session is.

| Demonstrated step | Conversion decision | Required check |
| --- | --- | --- |
| Sign in, SSO, MFA | Keep calibrated browser authentication if required; transfer a supported cookie snapshot to the actor's HTTP session when appropriate. | Probe the actual HTTP session's principal, role and tenant before dependent operations. Cookie import alone does not prove identity. |
| Populate and save a form | Map fields into an explicit JSON/form request and dispatch once. | Preserve validation/state prerequisites, current CSRF/version data, returned resource identity and uncertain outcomes. |
| Load the saved record | Use a fresh HTTP GET through an authorised observer. | Check owner, stable ID, revision and intended persisted values, not only status 200/201 or a UI toast. |
| Upload, special widget or browser-specific behavior | Retain browser work where replacing it would change the objective; otherwise calibrate its underlying protocol first. | Bind a real synthetic fixture, check upload/processing completion and observe persisted attachment state. |

Use fresh runtime values for cookies/tokens, CSRF fields, resource IDs, revisions,
dynamic action identifiers and upload handles. Do not replay captured cookies,
stale framework action IDs or incidental browser headers as a reusable protocol.
Do not assume a framework's internal endpoint is stable after one capture.

## Author the operation and observer

An adapter owns the application-specific request mapping and prerequisite checks.
Its constructor and imports stay passive. Put checks inside the dependent
operation so calling a keyword directly cannot bypass them. `HttpSession.attempt`
supports an application principal probe plus one explicit dispatch; use
`before_dispatch` for current resource/precondition checks and intent reservation
when needed. Acquire fresh volatile headers through the supported session hooks.

Native Robot keywords express the journey using these operations and observers.
Keep proposed inputs, expected outcomes, dispatch evidence, actual response and
fresh persistence observations separate. A transport failure after dispatch can
mean an unknown effect: retain the evidence and reconcile with read-only queries
before deciding on another mutation. Do not add implicit retries, account fallback
or input repair. A principal probe can itself refresh a session; deliberate expiry
tests need an explicitly designed operation instead of the baseline probe path.

## Verify before handing the baseline to the testing agent

Replay against the authorised test application with a fresh persona and fresh
resource, then repeat with another permitted persona. Check actor binding,
persisted state and that prerequisite failure prevents later requests. Preserve
acceptance evidence outside this repository. Only claim the scope actually
observed; a local synthetic walkthrough is not real application acceptance.

After that baseline works, the testing agent can derive explicit mutations:
roles, object IDs, field values, request order, expiry and other authorised test
conditions. Preserve each deliberate change and its intended/observed result.
Do not let baseline helpers silently repair a negative test, select another
account, or turn a failed mutation into an apparently successful baseline.

The [worked example](examples/http-first/README.md) includes a synthetic event
bundle, exact flow projections, a Robot suite, an HttpSession adapter, and a
local fixture that checks two fresh principals and a failure that must stop
dispatch. Use its structure, then calibrate the actual application's protocol.
