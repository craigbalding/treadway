---
name: treadway-recorder
description: Bootstrap and assist a human-driven journey with the Treadway Chrome recorder, preparing usable personas and confirmed verification contacts, then hand the capture to a flow-authoring agent.
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

Prepare a fresh, coherent persona with values usable in the actual form. A
synthetic fixture that parses is not necessarily a usable registration identity:
check required fields, formats, checksum rules, option labels, uniqueness needs
and external verification requirements. Generate plausible test values where
appropriate; reuse supplied values when intended. Keep the identity stable during
a journey and label subsequent personas distinctly. Avoid unnecessary personal
data. Do not use an already registered identity for a fresh-registration flow.

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

Configure the selected profile's recorder with the approved target hosts, agent
API key and available Jev key. Read credentials from existing private provisioning
without exposing them in messages or captures. Jev classifies controls; it does
not provide email inboxes, allocate addresses or verify identity. Preserve the
operator's chosen test-secret logging policy. Recorder API keys belong in local
extension settings, not persona facts or the exported event journal.

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

Let the human choose navigation, submissions and consequential application
choices unless they delegate them. Provide active assistance with field values,
Fill all, highlighted controls, verification and failures; do not interpret human
navigation as a request to withdraw AI help. Follow requests to fill or retrieve a
code within existing authorisation. Obtain mail through an already authorised
tool, or ask for just the received code when mailbox access is unavailable.

The recorder's Fill all skips passwords, one-time codes and unsupported controls.
Explain a specific unresolved field and help complete it; do not claim that a
secret reference contains a usable password. Use a private credential binding or
the operator's input as appropriate. Jev can classify fields lacking useful
labels, but classification is not proof of a correct or persisted value.

Coordinate with other agents before recording: SafeYolo's declared context is
agent-wide, not profile-local. A testing agent must not overwrite the recorder's
declaration or mix independent target work into the demonstration. Maintain the
hold until the operator finishes or explicitly changes the arrangement. A human
recording a baseline is not authorisation to launch independent assessment tests.

Use meaningful step markers and expected outcomes without making the human
annotate every click. Preserve their current tab, populated values and capture
when helping. Reconcile a dispatched or uncertain submission before retrying;
do not change personas or silently submit twice to get past a failure. Preserve
intentional test inputs when demonstrating a negative case.

## Finish and hand off

Stop and save when the operator finishes. Check the acknowledged output path,
latest revision, pending requests and content-drain results. Retain explicit gaps
and late responses; ensure the final revision is saved before closing. Do not
discard an incomplete run to make the result look successful.

Keep the journal, persona bindings, expected outcomes and exact SafeYolo captures
together privately. Use each observed `safeyoloRequestId` to retrieve its FlowStore
record; a Chrome request ID or nearby timestamp is not an exact join. Verify body
retention rather than assuming an ID proves complete evidence.

Hand the bundle to a flow-authoring agent with the intended actor, demonstrated
result and unresolved steps. Prefer HTTP operations for repeatable application
work, retaining browser operations where required. Check actual principal and
independent persisted state before claiming a working baseline. Subsequent test
mutations belong to a distinct authorised phase. See `recorder/CONVERSION.md` for
the conversion and baseline acceptance workflow.
