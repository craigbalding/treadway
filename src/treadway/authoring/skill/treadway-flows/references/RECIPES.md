# Flow recipes

Resolve shipped browser assets without a checkout:

```python
from pathlib import Path
import treadway
browser_root = Path(treadway.__file__).parent / "browser"
```

Pass that path through JSON to Node; `require(path.join(browserRoot, 'widgets.js'))`
loads the installed implementation and its adjacent locked dependencies. See the
reference `browser.cjs` for complete executable examples of the first six recipes.
For each recipe, preserve its identity and uncertainty rules when changing selectors.

| Need | Reuse | Site-specific responsibility |
| --- | --- | --- |
| Inspect actions and fields | `FormAssessor.inspect()`, `.locate(selector,{kind})` | Actual actor/resource, explicit scope/frame; select one observed action |
| Search and select | `Autocomplete.prepare/select` | Query-specific read-only `ready`, exact label and actual option ID |
| Edit and save | `PreparedEdit.prepare/bind/commit` | Current revision, field/action mapping, exact native form or AJAX target guard |
| Set dates | `DateRange.prepare` then guarded commit | Explicit ordered ISO dates; supported text controls, actual persisted date semantics |
| Enter a note | `RichTextEditor.prepare` then guarded commit | Literal plain text; supported contenteditable structure |
| Observe one request | `RequestObserver.run(dispatch, options)` | Exact route/method, actual response schema/status/resource, independent persistence |
| Change multiple selections | `MultiSelect` | Actual IDs, exact before/after arrays, explicit removal mapping |
| Open inline editing | `InlineEditor.open` then prepare/commit | Explicit opening action, actual resource and current editor scope |
| Upload/download | `uploadFile/downloadFile` from `transfers.js` | Private run root, actual input/name/hash, resource/effect observer |
| Run a Node operation from Python | `run_json_process` | JSON stdin, timeout, retained payload and failure; enforce completed transport |
| Compare persisted fields | `require_expected_fields` | Authoritative complete observation and evidence references; independently sourced expectations |

## Asynchronous choices

A matching label in an old list is not readiness. In the reference, `ownerReady`
requires the current response's query marker, exactly one enabled current result,
and the expected actual person ID. Core then retains that controller relationship
and rejects replacements before selection. A real site may expose a response ID,
loading state or request evidence instead of `data-query`; observe that site's
actual contract. Never add a fixed sleep or repeat the query until a label appears.

```js
const choice = new Autocomplete(ui, {field: '#owner', windowMs: 2000});
const prepared = await choice.prepare({snapshot: await ui.form.inspect(),
  query: person.name, source: 'requested owner', label: person.name,
  ready: () => ownerReady(ui, person.name, person)});
const option = await ui.form.call('locate', {selector: `[role=option][data-id="${person.id}"]`});
if (!option.ref) throw new Error('actual_option_missing');
await choice.select(prepared, {label: person.name, optionRef: option.ref,
  validateOption: () => ownerReady(ui, person.name, person)});
```

## Guarded editing and request observation

`prepare` applies explicit sourced inputs; `bind` adopts already prepared values
without typing twice. Bind the whole final patch after composing autocomplete,
dates and note input. The reference supplies an exact native form URL/method and
checks the issued resource revision again in `commit({validate})`. An AJAX-only
site needs an appropriate fresh application guard. Do not silently repair stale
bindings. The callback must return exactly `true` to authorize dispatch.

Attach `RequestObserver` before the explicit action. Require complete capture,
returned action, expected number of requests, status and typed response. Its
`applicationOutcome` remains `not_evaluated`; the adapter reads persisted fields
through an independent observer before returning a usable updated binding.
A captured HTTP 409 is different from a guard refusing to send any request.

`DateRange` supports the existing text-input mechanics, not every native date
picker. `RichTextEditor` inserts plain text, not arbitrary rich document markup.
React/Vue fixture coverage does not establish universal component-kit support.
Read installed module signatures before using profiles beyond this reference.

## Failures, reconciliation and cleanup

A failing prerequisite must stop subsequent native Robot keywords. Add a negative
case that inspects the actual effect, not only an exception string. The reference's
competing writer changes the persisted revision; the attempted plan is refused,
and the observer proves `writes` remains zero. The reference validates this before
dispatch; it does not claim the server rejected a submitted plan.

An interrupted create can have an actual effect. Retain its response-bound ID
immediately, reconcile it through a read-only observer, and do not create another
resource merely because the runner failed. Teardown acts only on IDs owned by the
run, verifies absence independently and records cleanup separately. Inspect the
retained private database when cleanup is incomplete.

For transports and transfer receipts, check completeness before using them. Keep
partial response bodies, actual bytes/hashes and uncertain outcomes available;
absence of an observation is not evidence that no action occurred.
