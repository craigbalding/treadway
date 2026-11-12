# Form discovery and instrumented actions

`form-assessor.js` supplies a small form interaction layer for agent-assisted
discovery and Robot composition. It uses the existing CDP client, rather than a
second browser driver. Start with the actual current step. Framework support
grows through calibrated interaction patterns; this first slice is checked
against real React 18 controlled fields and a custom combobox in Chromium.
It does not claim universal React, MUI, or multi-step application support.

Three capabilities share the same observations:

- **Discover:** actions first, then fields, constraints, errors, step markers,
  choices and dialogs. Agent reasoning selects candidate values and meaningful
  actions from this structured snapshot, optionally using established site knowledge.
- **Apply candidates:** sourced text values and explicit checkbox/radio choices,
  verified through DOM readback. Real CDP input events support React controlled
  inputs and blur handlers. Native single selects use their setter and events.
  For custom choices, open the actual control and select an observed option.
- **Attempt an action:** one explicit click, bounded observation, field changes,
  validation events/feedback, request references, and native/in-page dialog detection.
  No automatic retry, fallback option, dialog acceptance, or combined Next-then-save.

`Save draft`, `Save and exit`, `Next`, `Back`, `Submit`, `Discard` and other
secondary actions must not disappear behind a submit heuristic. Every snapshot
starts with **all page actions**, including hidden/disabled entries and controls
outside the form; each has a reference, label, scope/form association and state.
Labels are observed text, not verified behaviour. Exact-label selection refuses
ambiguous or disabled actions. Never silently choose the first matching button.

The utility should answer an unsuccessful attempt in the same call: which fields
are still empty under declared constraints, their labels and associated feedback,
whether inputs were retained/cleared, whether the browser responded, whether a
dialog appeared, and which requests were observed. It never labels a situation
"wedged" or promotes a speculative cause into an observed fact.
Live-region/alert text is retained with its observed source. An alert can announce
success: without an invalid-field or explicit component error marker it produces
unclassified page feedback, not a validation-failure diagnosis. The historical
`errors` array name does not certify the meaning of every message.

## Node usage

Use the actor's existing explicitly resolved CDP session. The site operation must
establish the expected live principal and resource; a target ID alone does not
prove identity. Establish any environment-specific traffic attribution through the consuming integration.
Use that integration's capture facilities where independent request evidence is needed.

```javascript
const { FormAssessor } = require('./src/treadway/browser/form-assessor.js');
const form = new FormAssessor(session, {
  scope: '#application',
  emit: event => publishProgress(event),
  record: entry => appendAndFlushRestrictedAttemptRecord(entry),
});
const snapshot = await form.inspect();
// Agent selects a specific observed field and proposes a sourced candidate.
const applied = await form.apply(snapshot, [
  { ref: selectedField.ref, value: candidateValue, source: 'synthetic customer fixture' },
]);
if (!applied.complete) return applied;
// Agent selects the intended observed action; do not infer submit from the form.
const result = await form.attempt(applied.after, selectedAction.ref, { windowMs: 1500 });
```

For a custom select, call `attempt(snapshot, field.ref,
{intent:'open_choices'})`, inspect returned listboxes, and choose one exact
observed option with `attempt(opened.after, option.ref,
{intent:'choose_option',fieldRef:field.ref})`. The listbox must be associated
through that field's `aria-controls` or `aria-owns`; no arbitrary visible-list fallback. IDs
from both attributes are combined, with the same ID deduplicated. Conflicting
paths, missing IDs and duplicate DOM IDs block selection. Each
control ID must resolve to exactly one DOM element, which may be the listbox
itself or a wrapper containing it. Visible listboxes expose
`controllers: [{fieldRef, controlId, containerRef}]`. Combobox fields expose
`controlledElements: [{controlId, matchCount, containerRef, disabled, listboxRefs}]`
and `choiceUsable`. Missing/duplicate IDs remain observable; they do not produce
an invented association.

Selection requires exactly one visible related listbox and one controller path
for the selected field. The option's nearest owning listbox must be that listbox,
and the option must be visible and enabled; the field, listbox and controlled wrapper must also be
usable. The caller's observed relationship must still match the refreshed
snapshot. Pointer preparation rechecks the DOM relationship before dispatch.
An ambiguous, changed or unavailable relationship requires inspection again.
Autocomplete text entry requires candidate `interaction:'type_query'`, then
explicit option selection. An explicit combobox query retains focus so components
that clear search text on blur can expose their current choices. Ordinary fields
still tab out for focus/blur handling. If a component requires reopening, use
`open_choices` explicitly and inspect again. Query readback does not prove selection.
Some controls require an additional adapter; refusal is preferable to silent
normalization or a fabricated selection.

`inspect()` is passive: it reads existing validity without calling
`checkValidity()`/`reportValidity()` or opening menus. Opening a menu or triggering
validation is active. Main-document DOM coverage excludes cross-origin frames,
closed shadow roots, and unexposed future steps. Declared requirements do not
describe every custom/server/cross-field rule. Step markers and errors may need
site knowledge where accessible semantics are missing.
Labels containing `*` are returned as `requirementHints`; an empty such field
appears under `possiblyRequiredEmpty` even if native `required` is false. This
is a prompt for calibration, not a declaration of the server's requirements.

### Explicit iframe editors and plain text

`new FormAssessor(session, {frameSelector:'iframe[name="editor-canvas"]', record})`
selects one visible same-origin iframe. Parent inspection inventories frames;
it never silently changes the active document. Frame snapshots bind the parent
document, actual iframe node/frame ID and child document. New parent dialogs,
frame replacement and stale contexts block input. Pointer coordinates account
for iframe borders and scrolling, and the parent must actually hit the iframe.
Cross-origin, nested, transformed/scaled frames and shadow roots remain outside
this calibrated slice. Robot accepts the equivalent `frame_selector` constructor
argument. Every CLI call reestablishes that explicit context.

Editable hosts require candidate `interaction:'insert_plain_text'`. Native
pointer/keyboard events select and replace text; selection must belong to the
bound host before deletion. The operation reads back every candidate after the
whole patch. It does not assign `innerHTML`, set framework state or infer rich-text
semantics. Unsupported editor structures require an application adapter.
These mechanics are checked against the local same-origin React iframe under CSP
and its plain-text editable host. The versioned observation schema
is `treadway.form/4`; application persistence still requires a separate observer.

## Robot and CLI

`treadway.robot.FormLibrary` is a thin Robot library. Each call returns actual objects and
streams phase messages to the native Robot console. Its Node subprocess is
bounded, uses an exact browser target, and does not renew sessions or choose
another principal. Required observation, input readback, action dispatch/observation and journal checks
are enforced. `FormOperationIncomplete` fails the Robot keyword; its `result` and
`transport` attributes retain the full evidence. `Get Last Form Result` exposes both
for explicit recovery handling in Robot. Normal sequencing cannot advance merely
because a scenario author omitted an assertion. Expected application validation
feedback remains an observation when the mechanics completed; it does not fail
this mechanical guard. Native dialogs stop normal sequencing with retained evidence. Publish
results/progress through the existing consumer observation/artifact path in the
site operation; the adapter does not infer application completion or require a second service.

It reuses `treadway.process.run_json_process(command, input_data=...,
on_stderr=..., timeout_seconds=...)`, a shared stdlib subprocess transport.
Each pipe has one reader; callbacks run on the calling thread before exit.
The result contains `payload`, `exitCode`, `failure`, `stderrLines`, and
`progressErrors`. Site adapters should reuse this instead of writing a stderr
pump alongside `communicate()` or logging only after completion. Callback code
must be bounded. Nonzero-exit payloads remain available for effect analysis;
a runner failure still prevents a successful execution claim. Focused real-process checks cover streaming, large input/output, deadlines,
pipe-holding descendants and errors.

`require_completed_process(result)` enforces successful runner completion before
returning a usable payload. On failure, `JsonProcessIncomplete.result` retains
the entire transport result, including any reported effect. A positive payload
cannot override a timeout or nonzero exit. This preserves an expected HTTP
error response returned by a completed operation. FormLibrary enforces the same transport contract plus operation-specific required
checks, preserving both layers in its typed exception.

```robot
*** Settings ***
Library    treadway.robot.FormLibrary
...        ${CDP_HOST}    ${CDP_PORT}    ${TARGET_ID}
...        ${OUTPUT DIR}/form-attempts.jsonl    scope=#application

*** Test Cases ***
Inspect And Observe One Draft Save
    ${form}=       Inspect Form
    ${save}=       Get Form Action    ${form}    Save draft
    ${attempt}=    Attempt Form Action    ${form}    ${save}[ref]
    # This result is interaction evidence. A calibrated application observer
    # must separately establish saved fields or a final submission transition.
    Should Be Equal    ${attempt}[completion]    unconfirmed
    ${history}=    Read Form Attempt History
    Log    ${attempt}[diagnosis]
```

CLI input is JSON on stdin, not credential-bearing command arguments:

```json
{"operation":"inspect","cdpHost":"127.0.0.1","cdpPort":9222,"targetId":"ACTUAL_TARGET_ID","scope":"#application"}
```

For `apply`, pass the returned `snapshot`, `candidates`, and `recordPath`.
For `attempt`, pass `snapshot`, `actionRef`, `recordPath`, and optionally
`windowMs`/`intent`/`fieldRef`. Required IDs come from actual discovery outputs.
`node src/treadway/browser/form-assessor.js < operation.json` emits a final JSON result
on stdout and immediate phase JSON on stderr. Mutating CLI calls require a
record path and flush the intent before dispatch. A missing directory or failed
write stops the action. Journal files use mode 0600.

For evidence retention, CLI inspection accepts `redactValues:true` and Robot
accepts `Inspect Form    redact_values=True`. Keep the returned object intact.
This option redacts nonempty field values/displays while retaining emptiness,
checkbox choices, refs, validity, guidance and all action states. It does not
redact arbitrary labels, errors or journal contents; keep restricted handling.
Avoid rebuilding evidence into a different hand-written schema.

## Attempt memory and outcome limits

Record sourced intended values, applied/read-back values, the selected action,
and the actual complete field state immediately before that action, including
checkbox/radio choices. Keep the outcome alongside the intent. This lets an agent
retrieve "Use a different delivery address was checked, street was empty" instead of reconstructing
it from commentary. Records are evidence artifacts, not a second scenario model
or traffic store. Password/hidden/recognizable credential fields are redacted;
URL query values are omitted. Other form values can contain personal data: use
the existing restricted evidence path. Do not put credentials in source descriptions.

An intent without a result means execution may have been interrupted. It does
not mean the action failed. `Read Form Attempt History` exposes an incomplete
trailing journal record rather than silently discarding it. Recall prior values
as history; recheck whether they hold now.

Keep **proposed**, **entered/read back**, **sent on the wire**, and **persisted**
separate. This utility does not inspect request bodies or certify completion.
`completion` remains `unconfirmed`, including after HTTP 200. Correlate traffic
through the consumer’s traffic evidence and use the calibrated application observer to
establish a saved draft or final submission. Browser-local request events are
candidate correlations, not proof of causal attribution, and no request observed
in this session/window does not establish global absence. A field cleared after
click is an observation, not sufficient proof of rejection. A command timeout
stops waiting without cancelling the browser action. Native dialog detection
covers events since attachment; an already-open dialog can still cause an
incomplete initialization. Do not claim it was ruled out.

Adaptive input refinement is for normal-flow discovery. When executing a
deliberate input variation, do not repair the stimulus or retry mutations to
obtain acceptance. The utility contains no autonomous candidate generator or
submission-until-success loop: the agent supplies coherent candidate patches,
Robot supplies sequencing, and the operations return specific feedback.

## Calibration checks

The optional browser fixture serves React locally and uses a fresh isolated
Chromium profile; it never drives an existing browser or an external application.
Install the development dependencies from the project root:

```sh
npm ci --ignore-scripts
CHROME_BIN=/path/to/chrome-headless-shell FORM_REACT_FIXTURE_ROOT="$PWD" \
  FORM_ROBOT_PYTHON="$PWD/.venv/bin/python" npm run test:browser
```

Checks cover controlled-state retention across a React render, explicit actions
and choices, validation-blocked submission, 200 plus business rejection, cleared
inputs, both dialog types, stale contexts, and intent-memory failures. Without
both environment variables the real-browser suite is explicitly skipped.

Primary references: React's [controlled input contract](https://react.dev/reference/react-dom/components/input),
MUI's [custom Select and accessible labels](https://mui.com/material-ui/react-select/),
and the browser's [constraint-validation behaviour](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Constraint_validation).

Application adapters can use `await form.locate(selector, {kind:'action'})` (or
`kind:'field'`) to bind a calibrated CSS selector to one observed reference. It
returns `{snapshot,item}`. Zero/multiple matches and nodes outside the requested
observed category are refused. Selection is read-only; normal context, visibility,
staleness and journal checks still apply when using the returned reference.

An inline editor with no save button can deliberately use
`form.attempt(snapshot, field.ref, {intent:'press_enter',windowMs:500})`. This is
one journaled Enter action on a supported non-sensitive text input, with the same
bounded observations and unconfirmed completion as a pointer action. It is never
selected as a fallback for another action. The consuming application must observe
whether the edit persisted.

Robot exposes this as `Locate Form Control    input[id="customer"]    kind=field`,
returning a dictionary containing `snapshot` and `item`. A selector beginning with
`#` must be escaped in Robot syntax because an unescaped `#` starts a comment.

Focusable table rows (`tr[tabindex="0"]` and `[role="row"][tabindex="0"]`) are
included in the observed action inventory, with behavior explicitly unverified.
An application adapter can bind one calibrated row selector and use the same
journaled pointer operation as a button. Selection/expansion/control attributes
are retained for observation. The application still owns what the row means and
must bind it to the intended resource and surrounding context.

Selector refusal messages report the observed match count; they do not fall back
to the first node or a similar label.
