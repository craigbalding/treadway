---
name: treadway-recorder
description: Bootstrap and assist a human-driven Treadway Chrome recording, discover persona needs from application context, prepare or enrich usable personas and confirmed verification contacts, then hand the capture to a flow-authoring agent.
---

# Assist a recorded journey

The human drives the application to teach a journey. The agent removes setup and
data-entry work, assists during the demonstration, and prepares the capture for
conversion into an efficient Treadway flow. Prepare the working setup yourself;
do not hand the operator personas JSON, API-key setup or recorder troubleshooting
as prerequisites they must perform.

Locate the Treadway checkout and read its `recorder/README.md` for the installed
version's configuration, persona schema and capture behavior. This skill can be
copied independently; resolve documentation against that checkout, not against
the skill's installation directory. Use `recorder/CONVERSION.md` when handing off
or converting a capture. Keep application identities and settings in private
runtime storage, outside source control.

## Bootstrap a usable demonstration

Recover the intended journey, browser profile, application and any persona or
contact preferences already supplied. Prepare the normal working flow before
deliberate testing variations. Inspect retained requirements and existing working
flows before asking questions or independently navigating the human's tab.

The agent may be seeing these forms for the first time. Use the client's short
application description, client/market context and intended actor to choose a
generous core persona plus relevant domain coverage. Refine that coverage from
available evidence; do not require an exhaustive form inventory before helping.
Read [persona discovery and enrichment](references/persona-discovery.md) when
preparing new personas or revisiting them as an engagement develops. It covers
lightweight operator questions, public and SPA evidence, rich histories,
consistency checks and preserving manual corrections during enrichment.

For recorder 0.2, use the panel persona manager to inspect/edit facts, histories,
narrative and portrait. Create and Enrich use the configured structured-inference
provider directly, with local candidate validation and operator proposal review.
No Phone a friend, assistance inbox or local-agent wake watcher is used. Preserve
stable identity, contacts, credentials, manual overrides and history record IDs.
Existing persona examples and generator outputs remain ingredients; supply the
application brief and broad domain context rather than a thin random profile.

Prepare a fresh, coherent persona with values usable in the actual form. A
synthetic fixture that parses is not necessarily a usable registration identity:
check required fields, formats, checksum rules, option labels, uniqueness needs
and external verification requirements. Generate plausible test values where
appropriate; reuse supplied values when intended. Keep the identity stable during
a journey and label subsequent personas distinctly. Avoid unnecessary personal
data. Do not use an already registered identity for a fresh-registration flow.

Prepare common fields up front: given/family/full/display name, email and the
application's login identifier, plus known contact, address and form-specific
fields. Include a privately generated test password or resolve the intended
existing credential into the persona's private `credentials` values and reference
names. Respect an existing chosen password. This preparation works together with
the extension's native defaults and password generation; routine fields should
not require another agent conversation. Read the installed recorder version's
schema rather than declaring a missing built-in field unsupported: extra persona
field keys are offered to Jev as classification choices.

For email verification, use an address the operator confirms they can receive.
Propose the exact address, including a fresh alias suffix where appropriate, and
ask whether it reaches them. Reuse an existing confirmation covering that mailbox
and alias pattern; do not ask again for every suffix. Do not infer that plus
addressing works, guess the mailbox domain, or treat a reserved example domain as
deliverable. Operator confirmation establishes intended routing; receipt of the
actual verification message is a separate observation. Use a different mail
service only when that is the operator's chosen approach. Apply the same reasoning
to required SMS or other verification contacts.

Use the recorder's own `parsePersonas` and `personaValues` helpers from
`recorder/lib/personas.js` to validate and inspect the prepared persona locally.
Facts must be non-empty strings; omit an absent optional fact. A supplied fact
overrides a generator of the same type. A deterministic generator seed must differ
where the application requires a fresh value. Format/checksum validity does not
prove that an external registry will accept an identifier. Resolve a real missing
prerequisite rather than making the human debug rejected placeholder data.

Configure optional Jev and direct structured inference from existing private
provisioning. Use a reviewed model and strict schema mode; do not invent a key or
substitute an unrelated credential. API keys belong in extension settings, never
persona facts or capture files. Jev reasons over rich context and observed options;
it does not generate free text, provide inboxes or verify identity.

Standalone recording needs no SafeYolo key. In a SafeYolo sandbox, use the narrow
native helper where available, installed for the exact extension ID following the
README. It reads the current guest token per command without returning it to the
extension. An explicit agent key supports managed browsers without that helper.
Do not weaken proxy, CA, browser sandbox or policy. An installed helper failure is
not permission to silently downgrade to standalone. No target-host list belongs
in the extension; supporting/identity sites can be discovered during the journey.

Prefer the recorder's Downloads mode when a native folder picker is unavailable.
Configure a writable output directory the agent can read, save settings, validate
the persona and check the visible panel for errors. Keep the browser sandbox
enabled. Verify export with a separate clearly labelled local probe if needed;
an export probe is not registration acceptance. Do not reload an extension or
restart a profile with an active or unsaved capture.

Give a short readiness message: selected persona and verification address, what
is configured, any one necessary confirmation, and the next human action. Ask
only for information or choices that cannot be recovered or prepared. Once ready,
the operator should be able to start and demonstrate the flow.

## Assist while the human drives

For live assistance, establish a passive view of the current recorder journal,
panel errors and relevant browser diagnostics. A final export appears on save;
watching its directory alone does not watch an in-progress journey. Confirm the
observer is receiving current events before saying that you are monitoring. If
live observation is unavailable, disclose that and arrange an accessible stream
without restarting or interrupting the active capture.

When the installed version provides `recorder/stream.mjs`, bootstrap it by default
with the owned BrowserManager session, exact extension ID and a private shared
JSONL destination. See the README's Live journal output instructions. Run it as
a managed long-lived task in the browser-owning sandbox; verify its companion
status file and panel connected state during setup, then a fresh journal event
when recording starts before claiming to monitor activity. Other
agents should read that file directly rather than asking the browser agent to
inspect each event. Re-arm on expiry/failure; resume the same file only for its
bound browser generation/extension. Preserve final Save and disclosed stream
gaps. This observational exporter is separate from direct inference and from Coord waiting.

Let the human choose navigation, submissions and consequential application
choices unless they delegate them. Provide active assistance with field values,
Fill all, highlighted controls, verification and failures; do not interpret human
navigation as a request to withdraw AI help. Follow requests to fill or retrieve a
code within existing authorisation. Obtain mail through an already authorised
tool, or ask for just the received code when mailbox access is unavailable.

Fill all uses supplied password values, generates and saves a missing registration
password, and defaults Display Name to full name. Jev chooses the closest
reasonable field type with a 0.51 Choice confidence floor and a separate
0.80 semantic-fit probability gate. Classification receives descriptors/type
names; semantic option decisions additionally receive non-secret categorical
intent values and observed options. The recorder can also send redacted
description, relevant structured facts, histories, preferences and circumstances
when a categorical fact is missing. An independent support gate rejects a best
guess without evidence. Explicit facts and operator overrides win; accepted
deductions are revision/context-bound and invalidated by edits. Credential and contact identifier values
stay in local filling paths. Help with an actually unresolved control or
live code; do not turn a helper limitation into a claim that the agent cannot
assist, or make the human prepare fixture data. A secret reference is not a
password value. Classification is not proof of a correct or persisted value.

Use the native semantic matching before rewriting a persona just to match UI
wording. Supplied degree/grade/institution facts can match equivalent displayed
options. The recorder batches descriptor matching, resolves stateful options when reached, waits for async suggestions,
and verifies a selected option against the shared Treadway widget binding.
Prepare explicit radio/checkbox facts where known (string Yes/No values are
supported), including relevant negative statements. Rich context may support
unforeseen categorical questions; missing facts alone are not permission to
invent a personal status. A lookup still needs a sourced query. Repeated history
rows need distinct facts bound to their own records. Existing human choices,
consent/attestations and file uploads remain operator-controlled. Observe the
panel's active phase, final fill report and remaining gaps before claiming success.
Fill all rereads saved personas, so agent fact updates require no timing-sensitive
Reload personas click. Preserve the same identity and generated credential cache.

One Fill all action uses local facts and Jev first, then direct LLM inference for
required content gaps. The panel validates and compare-and-swap saves additions
before the same filler uses explicit bindings. Existing values, contacts,
credentials, operator corrections and consents stay authoritative. Mechanical
failures are not a request to invent different persona values. Filling follows
live visual/semantic order, observes dependencies and stops at required gaps,
invalid prerequisites or uncertain outcomes. Use the remaining-fields list to
locate gaps and explicitly select the intended stable record for repeated
histories; do not assign records by ordinal guess. Do not type around a failing
recorder with a separate automation engine and count that as extension coverage.
Report and reproduce a mechanism gap with a focused local fixture.

Coordinate with other agents before recording: SafeYolo's declared context is
agent-wide, not profile-local. A testing agent must not overwrite the recorder's
declaration or mix independent target work into the demonstration. Maintain the
hold until the operator finishes or explicitly changes the arrangement. A human
recording a baseline is not authorisation to launch independent assessment tests.

SafeYolo context renewal runs automatically during recording and stops on Stop &
save. A failed or unconfirmed renewal remains visible and is not automatically
retried after worker restart. An explicit Renew can reconcile it. Do not replay an
application write to test renewal: preserve uncertain effects and let the operator
choose another attempt after reconciliation. Context expiry is separate from the
application's authentication session.

Use meaningful step markers and expected outcomes without making the human
annotate every click. Preserve their current tab, populated values and capture
when helping. Reconcile a dispatched or uncertain submission before retrying;
do not change personas or silently submit twice to get past a failure. Preserve
intentional test inputs when demonstrating a negative case.

## Finish and hand off

Stop and save when the operator finishes. Stop observers when an engagement ends; preserve artifacts and pending state, and do not resume old requests or perform target tidy-up after authorisation ends. Check the acknowledged output path,
latest revision, pending requests and content-drain results. Retain explicit gaps
and late responses; ensure the final revision is saved before closing. Do not
discard an incomplete run to make the result look successful.

When the operator ends the engagement, stop the assistance and journal observers.
Preserve captures, candidates and any pending request state. Do not contact or
reopen target pages to tidy up after authorisation ends. Before starting a new
engagement, reconcile retained requests with the operator's current intent;
do not automatically resume an old request or carry forward target authorisation.

Keep the journal, handoff manifest, persona revision bindings, expected outcomes and available exact SafeYolo captures
together privately. Use each observed `safeyoloRequestId` to retrieve its FlowStore
record; a Chrome request ID or nearby timestamp is not an exact join. Verify body
retention rather than assuming an ID proves complete evidence. Standalone journals have browser events and passive request metadata, but no SafeYolo FlowStore bodies; preserve that limitation explicitly.

Hand the bundle to a flow-authoring agent with the intended actor, demonstrated
result and unresolved steps. Prefer HTTP operations for repeatable application
work, retaining browser operations where required. Check actual principal and
independent persisted state before claiming a working baseline. Subsequent test
mutations belong to a distinct authorised phase. See `recorder/CONVERSION.md` for
the conversion and baseline acceptance workflow.
