# Treadway Flow Recorder

Demonstrate a journey once, using persona filling and step markers to reduce
manual work. Give the saved event log and the matching SafeYolo captures to an
agent, which authors a Treadway flow. Prefer HTTP operations for repeatable
application work; keep browser operations for authentication, browser behavior
and controls that need them. See the [conversion guide](CONVERSION.md) and the
[runnable HTTP-first example](examples/http-first/README.md).

For an agent-assisted demonstration, use the companion
[`treadway-recorder` skill](skills/treadway-recorder/SKILL.md). It asks the agent
to prepare usable persona data, confirm a receivable verification address with
you, configure the recorder, and help with filling and verification while you
drive. The packaged example personas are local demonstration fixtures, not
registration-ready identities. Install the `skills/treadway-recorder` directory
in your agent's skill directory, or have the agent read it from this checkout.

The recorder observes request metadata and SafeYolo response IDs passively. It
adds no application request headers and copies no request/response bodies into
the journal. Bodies remain in SafeYolo's FlowStore.

## Install and configure

Use Chrome/Chromium 116+. SafeYolo is optional; standalone recording, personas and assisted filling use the same controls. In `chrome://extensions`,
enable Developer mode and **Load unpacked** this `recorder` directory. Open the
side panel using its toolbar icon. Reload the extension after updates; reload
application tabs so the new content scripts attach.

SafeYolo's existing policy must permit the journey's destinations and enable
declared contexts where required. For example, an application may require:

```yaml
addons:
  test_context:
    target_hosts: ["app.example.test"]
    inject_declared: true
    declared_ttl_max: 1200
```

This policy is managed outside the extension. Its context-required hosts are
not a complete list of sign-in or supporting sites and do not filter the journal.

Fresh profiles default to **Downloads (no folder picker)**. In Settings, paste
your personas JSON, or click **Use example personas** and edit the example.
Optionally configure Jev and structured inference (provider, reviewed model, API key and optional base URL), then **Save settings**. No SafeYolo key is needed for standalone use.
The JSON uses the same [personas format](examples/personas.json) as folder mode.
Downloads mode stores its persona configuration in this extension profile and
writes `Treadway/journeys/<run>.json` beneath Chrome's Downloads directory. The
panel shows the actual saved path. An agent can configure the profile's Downloads
directory to a shared workspace before the trial; no folder chooser is needed.

**Chosen folder** is also available: choose a directory containing `personas.json`
and save settings. Existing configured folders keep that mode on upgrade.
Use Downloads mode where the native Linux folder picker is unavailable or crashes
in its GTK/image-loader stack. It avoids that dialog without changing browser or
image-loader sandbox settings. Both modes export the same event format.

### Optional SafeYolo integration

In a SafeYolo sandbox, install the narrow native host for the unpacked extension's
exact ID (shown in `chrome://extensions`):

```sh
python recorder/native/install.py EXTENSION_ID --browser chromium
```

Use `--browser google-chrome` for the regular Linux Chrome profile. The host is
user-owned and allowlisted to that extension ID. It reads `/app/agent_token`
for each command and makes only health/current-context operations through the
inherited proxy. It never returns or stores the token. An explicit agent API key
in Settings supports managed browsers where the native host is unavailable.
An absent optional helper permits standalone use; an installed helper failure or
failed authenticated identity check is reported rather than silently downgrading.

During recording, Chrome alarms renew the same context using its granted lease,
including after service-worker suspension. Stop cancels renewal. Another owner's
context is never replaced. Failed or unconfirmed renewals remain visible and are
not automatically retried after worker restart; an explicit Renew action can
reconcile them. There is no countdown UI. Renewal never replays an application
request, and it does not extend the application's own authentication session.

### Structured inference

The recorder uses direct `fetch` adapters for OpenAI, Anthropic, Groq, xAI and
OpenRouter; it bundles no model SDK. Only the reviewed native structured-output
catalog is selectable. Every request sends a strict schema and validates the
result using the bundled CSP-safe `@cfworker/json-schema` interpreter. Refusals,
truncation, invalid JSON and schema mismatches fail without text fallback,
response repair or automatic retries. Endpoint/model support can change: the
catalog is a reviewed configuration, not a promise of live availability.

Set an API key for the chosen provider. A base URL override must use HTTPS,
except local HTTP test endpoints. OpenRouter routing requires parameter support
and constrains routes to reviewed serving providers. Timeouts and cancellation
also cover reading the response body. Provider keys stay in private extension
settings, outside persona data and capture exports.

Optional Jev classification uses a TypeSafe AI key and needs policy access to
`api.typesafe.ai`.

**Record test passwords and one-time codes** is enabled by default. Turn it off
to record secret references instead of typed values. This setting is fixed when
a journey starts and applies to both rule-based and Jev-classified controls.
Fill all uses supplied test credentials and can generate a missing registration
password. The API keys live in this profile's extension settings; they are not
included in the journey file.

The journal observes all accessible tabs and frames while recording, including
newly encountered sign-in, verification and supporting sites. No host list is
required in the extension. SafeYolo policy still controls permitted destinations,
where declared contexts are required, and which request/response bodies are
retained. Browser observations and a response ID do not guarantee FlowStore body
retention for a supporting site. Start before opening the application or entering
its sign-in flow; activity from before Start is not reconstructed.
Use the intended test profile. Fill all acts only in the active tab's top frame.

## Demonstrate a journey

1. Pick a persona and name the journey. **Suggest name** uses the application brief and observed page metadata; suggestions remain editable. **Start** begins standalone capture, or reads the authenticated SafeYolo identity and declares a context containing `run`, `agent`, `role`, `test` and `persona`.
   Each run has a timestamp and random suffix; a journey's `test` name is stable.
2. Sign in normally. **Mark authenticated** can include the account you observed.
   This is an operator annotation, not an application principal check.
3. Add a step name and its expected outcome before the next meaningful action.
   Use **Fill all**, complete highlighted controls, and perform the action.
   For a save, inspect persisted state with a fresh load/read as well as the
   acknowledgement. Those observations make the later conversion much easier.
4. If SafeYolo returns a test-context block (428 with `X-Blocked-By: test-context`),
   the recorder renews its context on that encountered site and tells you.
   Explicitly repeat the blocked action when ready. It never retries application
   requests. An application's
   own 428 does not trigger renewal.
5. **Stop and save** stops new capture, interrupts any fill, drains available
   content-script messages, and clears the declaration only if it still matches
   this journey. Another owner's declaration is left intact. A declaration or
   clear with an uncertain outcome stays explicitly recorded.

The file is `Treadway/journeys/<run>.json` under Downloads, or `journeys/<run>.json`
in a chosen folder. A Downloads save is acknowledged only when Chrome reports
the file complete; interruption or an uncertain outcome retains the recording
for **Save again**. Later revisions overwrite the same run's export.
If requests were already
in flight, it is a pending snapshot. Their responses and completion/error events
remain associated with the original run and step after Stop. While the panel is
open it updates an already saved snapshot. If closed, reopen it and **Save again**
when requests finish. The stopped run stays available until its latest revision
is saved. You can **Finish with pending requests** to record an incomplete capture
explicitly; that does not cancel a request or establish its application effect.
A save failure retains the run for retry. **Discard** drops that retained capture.
Chrome session storage survives service-worker suspension, but is not a durable
backup across browser/profile shutdown; save before closing the test browser.

Start, Stop and renewal are serialized. A failed declaration can be uncertain;
use Stop to reconcile it before starting another journey. Do not run two recorder
profiles against one agent declaration concurrently: SafeYolo's context belongs
to the agent, not an individual tab or extension profile. The Stop ownership
check is a read-before-clear check, not a server-side compare-and-delete lock.

## Fill all

Fill all follows visual and semantic groups one control at a time. It reinspects
after completed events and observable DOM/network dependencies. A required gap,
invalid prerequisite or uncertain interaction stops downstream input. Descriptor
classification remains batched; stateful widget choices are resolved when reached.
Unannounced application work with no observable pending state cannot be proven
complete by a generic DOM quiet period.

One click first uses local persona values and Jev with the full redacted rich
profile. If required content is genuinely missing, a structured LLM call prepares
compatible persona additions. The panel validates and compare-and-swap saves them
before the same native filler uses explicit field bindings. Independently visible
text-data gaps are prepared together; newly revealed gaps can require another
bounded phase within that click. Cancellation, no progress, uncertainty or the
traversal/time budget stops the sequence. Existing facts, contacts, credentials,
operator values and declarations are not silently replaced. A failed widget
interaction never becomes a request to invent different persona content.

The remaining-fields list explains gaps and highlights their exact live bindings.
For repeated histories, choose the intended stable record in its history selector;
records are not assigned by ordinal guess. Bindings remain scoped to the recording
and observed document/form context. Profile management remains editable.

Empty, visible, enabled controls are classified using autocomplete, input type,
name/id/label/placeholder, then optional Jev. Field classification sends field
descriptions and available fact-type names. Each Choice is paired with an
independent Noul asking whether a supplied candidate actually fits. Choice
confidence below **0.51**, fit probability below **0.80**, missing fit answers,
and invented candidates are rejected. Ordinary Display Name controls have a deterministic mapping and
default to the persona's full name, with an explicit `display_name` taking priority.

Supplied `credentials.password` and `credentials.new_password` values are filled
locally. When an empty registration/new-password form has no supplied or saved
password, Fill all generates one and saves it in this profile **before** using it
in the password and confirmation controls. Subsequent fills reuse that credential.
It does not invent an unknown existing-account password on a sign-in-only page.
Downloads mode also adds the prepared credentials to that persona's local JSON;
folder mode updates the selected folder's persona with the same prepared credential.
Existing input is preserved; a conflicting password is highlighted rather than
overwritten. One-time codes still require a live value from the operator or agent.
Every Fill all reloads the persisted persona first, so an agent's saved fact
changes apply without a separate Reload personas click. Identity and saved
credentials remain bound to the same journey.

After a saved recording and an extension update, the `scripting` permission lets
the recorder reattach its content scripts to existing app documents. This avoids
reloading a partly completed application form. Only a known missing receiver
triggers reattachment; an uncertain fill dispatch is never automatically retried.

For selection controls, the recorder observes real options before asking Jev
which option expresses the persona's intended fact. Exact values/labels need
no model call. Independent descriptor questions are batched; stateful semantic choices are resolved against their current observed options, with a separate Choice for select/wait/manual. For example, an
intended degree classification can match a displayed abbreviation without
rewriting the persona to copy the UI's wording. Selection uses only an observed
option ID and the shared library's binding and hit-target checks. A changed
option set, URL or wizard step rejects the stale decision.

Semantic requests include the non-secret categorical intent and option labels.
Passwords, OTPs, payment data, API credentials and supplied contact identifiers
are excluded from these requests; those values stay in local filling paths.
Jev selects from supplied facts/options or the redacted persona context described below; it does not generate missing free text.
At most 255 observed options are considered per control; a larger result needs
a narrower lookup rather than silently truncating the choice set.

Failed query-retention or changed-control observations include a bounded
`queryDiagnostics` trace on that control's fill report. Up to 24 samples capture
phase/focus events, `document.hasFocus()`, logical binding availability, original
node connection/replacement, query equality and value length, expansion, loading
and observed option count. The active element contributes only a generic tag,
known role and input type. No query/value text, labels, IDs or selectors are
retained in this diagnostic. Initial focus/dispatch samples, a rolling recent tail, a dropped-sample count
and the final failed state keep long waits bounded without losing a late blur. Successful controls carry no trace; temporary observers are
removed before cleanup or cancellation. This evidence diagnoses a failure and
does not trigger retyping, refocusing or retries.

Autocomplete uses a sourced query and waits within the library's 15-second
choice window. A still-loading widget can obtain one bounded wait decision and
continue observing the same pending query. Newly appearing options then justify
a second decision request. It does not repeatedly type while a lookup is pending.
Option discovery closes its own popup and restores only its own uncommitted
query. Applying the chosen option may reopen the widget and perform a second
lookup; the option set must still match. A typed query alone is never success.
After an option click, the recorder also waits up to 1.5 seconds for that exact
popup to finish closing. A quiet DOM alone does not establish that a closing
modal backdrop has released the next control. Stop and context changes interrupt
this observation; unrelated overlays still block filling.

Fields are applied sequentially with native setters and input/change events.
The helper re-resolves a unique live control after framework remounts, waits for
DOM settling (up to 1.5 seconds), reads its value back, and checks earlier fills
again at the end. Up to three passes cover newly revealed fields. A successful
fill means the live control held the value at readback; it does not prove that
the application accepted or persisted it.

The recorder distinguishes its own synchronous input/click effects from human
edits even when Chromium marks a generated radio change as trusted. Real operator
input during a pending model request remains recorded and prevents overwriting.

Readback records the intended/expected and observed values separately. A retained
value with native or ARIA validation errors is reported as `validation error`,
with the observed validation state; it is not counted as a successful fill or
mislabelled `did not stick`. That latter reason means the expected value was not
retained. Validation can change after a later field, so the final readback checks
both retention and validation again.
Required-field asterisks can change without replacing the control. They remain
in the observed label but do not invalidate its binding. Other question changes
and ambiguous matches still stop filling. An unresolved binding is reported as
`field changed`, with unknown retention (`null`); it does not establish that the
entered value was lost.

Radio groups and checkboxes can use explicit persona facts such as `"retired":
"No"` or `"has_registration_number": "No"`. Negated checkbox wording is matched
against the fact's meaning rather than blindly copying a boolean. Existing radio
choices and trusted human checkbox edits are preserved. Consent and attestation
checkboxes remain operator decisions. File inputs and unsupported multi-selects
are reported as gaps, rather than disappearing from the report. Controls disabled
by an earlier fill are retained separately as observed skips.

Manual reasons include `unclassified`, `secret` (no usable credential), `no persona value`,
`no matching option`, `ambiguous option`, `did not stick`, `validation error`, `field changed`,
`option match not confirmed`, `options changed`, `options still loading`,
`decision service unavailable`, `form context changed`, `operator decision`,
`file requires operator`, `multiple selection requires human`, and
`recording stopped`. Single-choice ARIA
comboboxes select one exact matching option from their controlled listbox using
the library's existing form runtime and choice-binding checks. The recorder
ships generated copies of these modules; `node recorder/build-runtime.mjs --check`
verifies they match the library source. Hidden backing inputs are excluded.
File events
record selected-file metadata and a fixture binding, not file contents or a
reusable fake path. Human multi-select events include `selectedValues`.

The current binding uses tag, input type, id, name, label and form id/name.
Duplicate controls remain unresolved rather than selecting an arbitrary match.
Changed bindings need operator review. Manual highlights clear on trusted input;
a later remount can remove a highlight, so also inspect the panel's report.

## Personas

Paste a JSON document containing a `personas` array in Downloads mode, or put it
in the chosen folder's `personas.json`. `id` and `role` must use letters,
digits and `_ . : -`. `label` defaults to `id`. `facts` supply fixed values;
`generate` supports `ppsn` and `test_card` with `seed` defaulting to `id`. Facts
win over generated values. Dates use `YYYY-MM-DD`; text inputs showing a date
layout receive that layout. Generators are deterministic test-data helpers,
not evidence that an identity or payment instrument is authorised.

```json
{
  "personas": [{
    "id": "casey-submitter", "role": "submitter", "label": "Casey Example",
    "facts": {"given_name": "Casey", "family_name": "Example", "email": "casey@example.test"},
    "generate": ["ppsn", "test_card"],
    "secrets": {"password": "CASEY_PASSWORD", "one_time_code": "CASEY_CODE"}
  }]
}
```

`secrets` contains reference names. An optional private `credentials` object
contains supplied test password values, for example
`{"password":"EXAMPLE_ONLY_PrivateTestPassword7!"}`. The same value can serve a
new-password pair; provide distinct `password` and `new_password` for a password
change. Agents should generate real trial credentials privately instead of using
the published example. A reference name alone is not a password value. Supported field types
include names, contact/address fields, dates of birth, username, PPSN, payment
card fields, passwords and one-time codes; see [fields.js](lib/fields.js) for the
complete list. Additional fact keys are offered to Jev as choices. The event log
records whether each fill came from persona facts or a generator.

The panel shows the active fill phase. Fill events include model decision
provenance, fit/confidence, selected labels, batch sizes/timings, final readback,
and observed skips. These describe assistance decisions, not extra business
submissions. Stop cancels pending filling; late model replies cannot apply values.

### Inspect, edit and enrich personas

Version **0.1.8** adds a persona manager in the panel. Open a persona to inspect its
portrait, description, editable facts, domains, preferences, circumstances and
history records. Add fields or records, correct values and **Save changes**.
Local checks show each pass, failure, uncertainty and preparation gap; **Validate
with Jev** adds named semantic checks when configured. A passing check does not
prove an identifier is issued, an address receives mail or an application accepts it.

**New persona** creates an editable local draft. **Create with AI** and
**Enrich selected** call the configured provider directly, without an agent inbox
or watcher. Give the short application brief, market, actor and newly discovered
context. The helper builds a generous core, relevant domain histories/preferences
and a coherent narrative without requiring prior knowledge of every form.

Generation produces structured candidates. Locally generated cryptographic test
credentials and distinct embedded DiceBear portraits do not require a provider
call. Existing verification contacts must be operator-confirmed; model output
cannot allocate or change receivable contacts or account credentials. Review
additions/conflicts before applying bulk persona changes. Cancellation, stale
source revisions and operator overrides prevent late or conflicting application.
These operations do not navigate, submit or change application accounts.

### Rich persona records and deductions

Existing flat personas remain compatible. Additional optional fields are:

| Field | Meaning |
| --- | --- |
| `description` | Coherent context, motivations and qualifiers consistent with the facts. |
| `referenceDate` | Date used for age and chronology checks, `YYYY-MM-DD`. |
| `portrait` | Stable packaged or self-contained image, alternative text and generation metadata. |
| `domains`, `preferences`, `circumstances` | Editable structured objects; arbitrary useful application fields are preserved. |
| `histories` | Named arrays of distinct records with stable record IDs, such as education or employment. |
| `provenance`, `overrides` | Sources by JSON-pointer path and authoritative operator corrections. |
| `revision`, `revisions` | Current input revision and prior snapshots; edits preserve stable identity/account bindings. |
| `deductions` | Accepted categorical answers with confidence, support, input revision and observed-control binding. |
| `accountLinks` | Existing account references, preserved by ordinary edits and enrichment. |

See the [substantive synthetic examples](examples/personas.json),
[discovery guidance](skills/treadway-recorder/references/persona-discovery.md) and
[optional pinned ingredient generator](tools/personas/README.md). The generator
reuses Faker, DiceBear and existing cryptographic credential helpers; an agent
still supplies coherent histories, narrative and relevant domain coverage.
Country fields are independent: residence, citizenship, document issuer, visa and
bank jurisdiction must not be collapsed into a single locale. Preserve generated
results, seed, package versions and reference date rather than regenerating an
existing identity while enriching it. Published examples use reserved contacts
and sample identifiers; replace verification contacts with operator-confirmed
routes before a real demonstration.

When no explicit fact exists for a categorical control, Jev may choose among the
observed options using redacted rich context. For example, current employment plus
supplementary-work plans supports Retired=No; age alone does not. A work-from-home
preference differs from actual availability. Each answer must meet the **0.51**
Choice and independent **0.80** support gates. Explicit facts and manual overrides
win. Credentials, contact values, account/document/payment identifiers and API
keys are excluded from semantic context. Jev does not generate free text; the configured LLM supplies missing required content in the completion stage.

Accepted deductions persist with the persona and capture. Reuse requires the same
input revision/signature, route, observed step/field context and option set;
edits invalidate deductions. A lookup still needs a sourced query, and a generic
history fact cannot be copied into several education rows. Distinct histories
need explicit row-specific facts or the remaining-fields history binding selector. Existing human
choices, consent and submissions remain operator-controlled. Changes wait for
an active fill to finish; editing a persona does not edit an application's account.

## Live journal output

The paired agent should start the supported live exporter before the human
demonstrates a journey. It uses the same owned BrowserManager session and the
recorder's read-only incremental journal interface. It does not navigate or
submit application requests, use an API key, or require a directory picker.
It works with both Downloads and chosen-folder journey storage:

```sh
node recorder/stream.mjs /private/browser/session.json /private/capture/live.jsonl EXTENSION_ID 28800
```

Use the exact extension ID from this profile and keep its panel open for initial
connection. Run the exporter as a managed long-lived task in the browser's
sandbox. Confirm the companion status file and **Live output connected** panel
state during setup, then verify a fresh event when the journey starts before
claiming to be monitoring its activity. Other agents can
read the shared file directly; subsequent observations require no agent relay or
Stop+Save. The default poll is one second, with immediate bounded-page catch-up.

The output is private append-only JSONL (0600). Event lines carry run, event ID
and revision; separate source/state/gap lines identify the browser generation,
extension, stopped/saved state and explicit retention gaps. Existing test-secret
recording policy is preserved and extension API keys are removed. Stream health
does not become a journey event. A companion `.status.json` reports the reader's
last successful page and cursor. The panel shows disconnected after five seconds
without reads and displays reported write errors.

Restart the same command against the same output to catch up without duplicate
event IDs. Existing file contents are authoritative; cursors advance only after
durable writes. A changed browser generation/extension, partial final line or
conflicting live writer stops export rather than mixing or discarding evidence.
Preserve a partial file for repair and use a new output for a different browser
generation. SIGINT/SIGTERM close the exporter cleanly; a normal run is bounded to
eight hours and needs re-arming afterwards.

Saved/discarded journals remain available for short catch-up: the extension keeps
up to four stopped runs in a conservative 3 MiB archive, trimming old events when
necessary. Service-worker suspension preserves this session archive, but browser
shutdown/extension reload does not. Delayed responses remain readable while a
stopped journey is retained, and its final archived revision survives the Save
acknowledgement. A consumer that falls behind retention receives an explicit gap;
the live file does not replace the final acknowledged journey export.

## Retired local-agent assistance

Phone a friend and agent-backed persona inbox work were replaced by direct
structured inference. The old runtime request handlers reject new work; retained
legacy files are not resumed. The observational journal stream remains available
and is independent of filling and persona generation.

## Journey format and exact request joins

Exports also include `handoff` (`treadway.handoff/1`): stable run/title, persona
revision signatures, extension build, exact request references, expected-outcome
markers and unresolved gaps. Each content event stamps its loaded version; the
panel distinguishes the loaded panel/background/page versions. A manifest does
not prove request-body retention or successful persistence. Standalone captures
retain browser events and passive request metadata; SafeYolo FlowStore bodies
are available only when that optional integration actually recorded them.


The export uses `format: "treadway-journey-events/2"`. Consumers must check this
version; v1 lacked exact request joins and document provenance. The top level
contains context fields, persona/reference metadata, start/stop timestamps,
secret policy, revision, `networkCapture`, and an append-only `events` array.
`personaRevisions` retains the redacted contextual inputs used by each captured
fill; fill events retain accepted deductions and their source revision. Later
persona edits do not rewrite this evidence. Use these bindings when converting
the capture into an HTTP-first flow, preserving browser steps where required.

Each event has a unique `eventId`, `stepId`, source timestamp `at` and background
receipt timestamp `receivedAt`. Page observations include Chrome's actual
`tabId`, `frameId` and `documentId`, plus the content script's document instance
and client event IDs. Source clocks and message delivery can differ; receipt
order and timing alone do not prove causality.

| Event family | Evidence retained |
| --- | --- |
| `page`, `navigation` | Page title or navigation URL; committed documents, history push/replace, and fragment changes with frame/document identity. |
| `click`, `submit`, `field` | Selector candidates, control descriptors, human values and classification, checked/selected states or file metadata. Input and change can both describe the same edit; fold them at the action boundary. |
| `fill`, `fill_error` | Observed fill/readback results, expected values, sources, manual reasons and partial/interrupted outcomes. |
| `marker` | Step/expected outcome or observed account, explicitly `source: operator_annotation`, with the active tab/document. |
| `network_request` | Chrome request ID, URL/method/type, start time and run/step/frame binding. |
| `network_response` | Every observed response leg: status, response index, cache flag, exact SafeYolo ID or missing/ambiguous correlation. |
| `network_redirect`, `network_completed`, `network_error` | Redirect destination, linked response event, terminal outcome or transport error. |
| Context/flush/incomplete events | Declaration/renewal/clear outcomes, content drain results and explicit abandonment of pending capture. |

`chromeRequestId` groups Chrome's request lifecycle; it can span several redirect
or authentication response legs. **`safeyoloRequestId` comes from the observed
`X-SafeYolo-Request-Id` response header and is the exact FlowStore lookup key.**
Do not substitute a Chrome ID, a run name, URL or nearest timestamp. The run
context remains useful for discovering related/background captures.

`flowCorrelation` is `response_header`, `missing_header`, `ambiguous_header` or
`no_response_headers`. Distinct competing header IDs are preserved without
choosing one. A cached response can refer to an older retained flow: inspect
`fromCache` and the stored wire timestamps. A header reference does not establish
that a full original body is retained; retrieve and verify it separately.

Requests bind to the run and step at request start. `precedingUiEventId` is an
optional same-frame temporal candidate, labelled
`uiAssociation: preceding_event_only_not_causality`. One action can cause many
requests, and a request may have no identifiable UI action. Do not manufacture
one-to-one links. Responses without a browser tab, restricted Chrome pages,
pre-start traffic, some worker traffic and service-worker synthetic responses
may have no journal join; record that limitation in the conversion evidence.

`networkCapture.complete` describes only tracked network outcomes. It does not
certify complete browser coverage, successful content drains, complete stored
bodies, a correct account, or successful application persistence.

## Validation

```sh
npm ci --ignore-scripts
npm run test:recorder:logic
python -m unittest discover -s recorder/tests -p test_native_host.py
npx playwright install chromium
python -m pip install -e '.[robot]'
RECORDER_REQUIRE_BROWSER=1 npm run test:recorder:browser
python recorder/examples/http-first/walkthrough.py
```

The browser suite loads the actual extension in sandboxed Chromium with a local
synthetic proxy and React fixtures. It covers remounts, rejected edits, dynamic
fields, classifications, secret modes, SPA routes, same-URL frames, file metadata
and exact request IDs. Contract tests cover redirects, cache/error/missing IDs,
concurrent transitions and late outcomes across Stop/save. CI requires the
browser suite; it cannot silently skip missing Playwright. Optional overrides:
`RECORDER_PLAYWRIGHT` (module path), `RECORDER_CHROMIUM_BIN` (browser binary).
Ubuntu CI installs the downloaded Chromium build's matching sandbox helper in a
root-owned, setuid location and selects it via `CHROME_DEVEL_SANDBOX`, following the
[Chromium sandbox guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
The browser sandbox stays enabled; no system-wide namespace restriction is changed.
These fixtures do not constitute acceptance against a real SafeYolo proxy,
TypeSafe service, paid model provider, or a particular real application. Local Docker lab acceptance is recorded separately from these deterministic checks. Automated compilation, principal verification,
cross-role replay and testing mutations remain the consuming agent's work.
