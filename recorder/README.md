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

Use Chrome/Chromium 116+ behind the SafeYolo proxy. In `chrome://extensions`,
enable Developer mode and **Load unpacked** this `recorder` directory. Open the
side panel using its toolbar icon. Reload the extension after updates; reload
application tabs so the new content scripts attach.

SafeYolo policy must list the target hosts and enable declared contexts:

```yaml
addons:
  test_context:
    target_hosts: ["app.example.test"]
    inject_declared: true
    declared_ttl_max: 1200
```

Fresh profiles default to **Downloads (no folder picker)**. In Settings, paste
your personas JSON, or click **Use example personas** and edit the example.
Enter the SafeYolo **agent** API key and matching target hosts, then **Save settings**.
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

The context timer defaults to 20 minutes; SafeYolo may cap it. Wildcard host patterns
match subdomains, not the parent host. Optional Jev classification uses a TypeSafe
AI key and needs policy access to `api.typesafe.ai`.

**Record test passwords and one-time codes** is enabled by default. Turn it off
to record secret references instead of typed values. This setting is fixed when
a journey starts and applies to both rule-based and Jev-classified controls.
Secrets are always entered by the operator, never by Fill all. The API keys live
in this profile's extension settings; they are not included in the journey file.

The journal observes all accessible tabs and frames while recording, including
non-target pages. `targetHosts` controls context renewal, not recording scope.
Use the intended test profile. Fill all acts only in the active tab's top frame.

## Demonstrate a journey

1. Pick a persona and name the journey. **Start** reads the trusted agent identity
   and declares a context containing `run`, `agent`, `role`, `test` and `persona`.
   Each run has a timestamp and random suffix; a journey's `test` name is stable.
2. Sign in normally. **Mark authenticated** can include the account you observed.
   This is an operator annotation, not an application principal check.
3. Add a step name and its expected outcome before the next meaningful action.
   Use **Fill all**, complete highlighted controls, and perform the action.
   For a save, inspect persisted state with a fresh load/read as well as the
   acknowledgement. Those observations make the later conversion much easier.
4. If SafeYolo returns a test-context block (428 with `X-Blocked-By: test-context`),
   the recorder renews its context and tells you. Explicitly repeat the blocked
   action when ready. It never retries application requests. An application's
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

Empty, visible, enabled controls are classified using autocomplete, input type,
name/id/label/placeholder, then optional Jev. Jev receives field descriptions
and option labels, never persona values. Confidence below 0.6 is ignored.

Fields are filled sequentially with native setters and input/change events.
The helper re-resolves a unique live control after framework remounts, waits for
DOM settling (up to 1.5 seconds), reads its value back, and checks earlier fills
again at the end. Up to three passes cover newly revealed fields. A successful
fill means the live control held the value at readback; it does not prove that
the application accepted or persisted it.

Manual reasons include `unclassified`, `secret`, `no persona value`,
`no matching option`, `ambiguous option`, `did not stick`, `field changed`,
`multiple selection requires human`, and `recording stopped`. Custom widgets,
checkboxes, radio groups, files and multi-selects need human action. File events
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

`secrets` contains reference names, not the values to type. Supported field types
include names, contact/address fields, dates of birth, username, PPSN, payment
card fields, passwords and one-time codes; see [fields.js](lib/fields.js) for the
complete list. Additional fact keys are offered to Jev as choices. The event log
records whether each fill came from persona facts or a generator.

## Journey format and exact request joins

The export uses `format: "treadway-journey-events/2"`. Consumers must check this
version; v1 lacked exact request joins and document provenance. The top level
contains context fields, persona/reference metadata, start/stop timestamps,
secret policy, revision, `networkCapture`, and an append-only `events` array.

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
npx playwright install chromium
RECORDER_REQUIRE_BROWSER=1 npm run test:recorder:browser
python -m pip install -e '.[robot]'
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
TypeSafe service, or application. Automated compilation, principal verification,
cross-role replay and testing mutations remain the consuming agent's work.
