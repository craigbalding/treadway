# Inspect and interact with a form

Use `FormAssessor` when an agent needs to inspect available actions and fields,
enter explicit values, then attempt one action. For an already mapped date,
autocomplete or editor, start with [widgets](REUSABLE-WIDGETS.md).

## Use the existing browser session

The following fragment assumes an owned connected `session`, a known field and
a private durable `record(entry)` callback. Resolve `browserRoot` from the
installed package as shown in [recipes](../src/treadway/authoring/skill/treadway-flows/references/RECIPES.md).

```js
const {FormAssessor} = require(browserRoot + '/form-assessor.js');
const form = new FormAssessor(session, {scope: '#application', record});
const {snapshot, item} = await form.locate('input[id="name"]', {kind: 'field'});
const entered = await form.apply(snapshot, [
  {ref: item.ref, value: 'Synthetic request', source: 'requested name'},
]);
if (!entered.complete) throw new Error('input_incomplete');
const save = await form.locate('button[id="save"]', {kind: 'action'});
const result = await form.attempt(save.snapshot, save.item.ref, {windowMs: 1500});
```

Replace the selectors with your application's controls. Establish the current
user and resource before the dependent action. The result records the action and
browser response; `completion` remains `unconfirmed` until your application
observer checks saved state. `inspect()` only observes; it does not open menus or
trigger validation.

## Use Robot keywords

```robotframework
*** Settings ***
Library    treadway.robot.FormLibrary    ${CDP_HOST}    ${CDP_PORT}    ${TARGET_ID}    ${OUTPUT DIR}/attempts.jsonl    scope=#application

*** Test Cases ***
Observe One Save
    ${form}=    Inspect Form
    ${save}=    Get Form Action    ${form}    Save draft
    ${result}=    Attempt Form Action    ${form}    ${save}[ref]
    Should Be Equal    ${result}[completion]    unconfirmed
```

Supply the actual owned connection values and add your saved-state check. A
mechanical failure raises and stops later keywords. `Get Last Form Result`
retains the result and transport for investigation. Enable the
[diagnostics listener](../src/treadway/authoring/skill/treadway-flows/references/DIAGNOSTICS.md#robot-logs)
for progress on stderr; the library does not print progress by default.

## Look up a specific interaction

- [Controlled choices and query input](reference/FORMS.md#node-usage).
- [Same-origin iframe editors and plain text](reference/FORMS.md#explicit-iframe-editors-and-plain-text).
- [JSON CLI and transport results](reference/FORMS.md#robot-and-cli).
- [Attempt history and uncertain outcomes](reference/FORMS.md#attempt-memory-and-outcome-limits).
- [Executable onboarding example](EXAMPLES.md) for a complete adapter and independent readback.

The [form API reference](reference/FORMS.md) describes exact fields, associations
and supported DOM coverage. Keep raw form values and journals private.
