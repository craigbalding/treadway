# Widget API reference

Start with [the task guide](../REUSABLE-WIDGETS.md) for a short example.

## Public modules

The Python distribution ships these CommonJS modules under `treadway/browser`.
They use the existing CDP session and `FormAssessor` observations. Constructors
and imports do no live work. Supply a private `record(entry)` callback before a
mutation; recording failure blocks dispatch or leaves the result incomplete.

| Module | Shared behavior | Adapter supplies |
| --- | --- | --- |
| `interactions.js` | `BrowserInteractions`: navigation, bounded passive waits, scoped actions/input, hover, scroll, explicit frame assessor | Origin, target/session, selectors, journal |
| `choices.js` | `ControlledChoice.prepare/select`: query, controlled-list association, exact option, stale/ambiguous rejection | Field selector or observed `{ref}`, optional readiness and actual-ID observers |
| `prepared-edit.js` | `PreparedEdit.prepare/bind/commit`: full patch validation, readback, retained references, fresh guarded submit | Named field mapping, explicit action, optional exact native-form contract and resource guard |
| `request-observer.js` | `RequestObserver.start/wait/run/dispose`: request-ID correlation, response and loading completion, bounded bodies and uncertainty | Request matcher; interpretation of the response |
| `transfers.js` | `uploadFile/downloadFile`: scoped paths, fixture hashes, one actual file input, named completed download | Private run root, explicit file/name, selector/action; resource identity and persistence |
| `widgets.js` | `Autocomplete`, `MultiSelect`, `DateRange`, `RichTextEditor`, `InlineEditor`, `PreparedEdit` | Component mapping and explicit values/transitions |
| `treadway.widgets.WidgetLibrary` | Native Robot keywords using the same JavaScript profiles through `widget-runner.js` | CDP endpoint/target, origin, journal, profile kind and JSON mapping |

`prepare` changes input only when explicitly requested. `bind` captures values
already prepared by a composed interaction, such as a taxonomy autocomplete; it
does not type again. `commit` rechecks values, references, action and configured
native-form target, runs an optional fresh adapter guard, then rechecks before
one dispatch. An asynchronous preview can replace controls during preparation;
the final binding captures those new controls. A later replacement blocks commit.

A native-form contract names `selector`, exact absolute `action`, `method`
(`get` or `post`) and explicit `methodOverride` (`null` or a string). It checks
controls and the chosen submit button against that exact form, including buttons
outside it using HTML's `form` attribute. Submit-specific action/method overrides
block dispatch. AJAX editors without native submission need an adapter guard;
a profile fingerprint alone does not establish business-resource identity.

`DateRange` validates real, ordered ISO dates before any input. Its field mapping
uses the existing text-input mechanics; it does not claim generic support for
locale-dependent native `input[type=date]` controls. `RichTextEditor` inserts
literal plain text into an observed contenteditable host. It does not serialize
arbitrary rich document formats. `InlineEditor.open` is a separate explicit step.
`MultiSelect` requires exact observed before/after values and an explicit removal
mapping; it never invents an option or clears a selection as recovery.

## Node composition

Given an explicitly connected `session`, canonical `origin` and private durable
`record` callback, a site's date editor can use:

```js
const {BrowserInteractions} = require(browserRoot + '/interactions.js');
const {DateRange} = require(browserRoot + '/widgets.js');
const {RequestObserver} = require(browserRoot + '/request-observer.js');
const ui = new BrowserInteractions(session, {origin, record});
const dates = new DateRange(ui, {
  start: '#start', due: '#due', action: {selector: '#save'},
  nativeForm: {selector: '#dates', action: origin + '/items/8/dates',
               method: 'post', methodOverride: 'patch'},
});
try {
  const prepared = await dates.prepare({
    snapshot: await ui.form.inspect(), start: '2026-12-07', due: '2026-12-11',
    source: 'explicit requested schedule',
  });
  const requests = new RequestObserver(session.cdp, {record, match: event =>
    event.request.method === 'POST' &&
    event.request.url === origin + '/items/8/dates',
  });
  const result = await requests.run(() => dates.commit(prepared, {
    validate: async () => await checkCurrentItemAndRevision(8),
  }), {windowMs: 15000, readBody: true});
  // Require complete observation and interpret actual status/body in this adapter.
  // Independently read the bound item's persisted state before claiming completion.
} finally {
  ui.dispose();
  session.close();
}
```

`checkCurrentItemAndRevision` is adapter code and must return exactly `true` to
permit dispatch. A callback can throw to preserve a specific prerequisite failure.
`RequestObserver.run` invokes its action once, retains action failure separately
from any observed response, and always removes its own listeners. For a wider
observation interval, use `start()` and `wait()` inside `try/finally dispose()`.
No HTTP status is interpreted as application success by core.

A controlled choice similarly composes `prepare({snapshot, query, source,
label, open})` and `select(prepared, {label, optionRef, validateOption})`.
Only explicit `open: true` opens choices. A read-only `ready({snapshot, fieldRef,
list})` callback may wait for the intended asynchronous results. Selection still
requires an exact unique visible enabled option in the field's current controlled
list. Use `validateOption` to bind actual IDs rather than normalizing labels.

## Native Robot composition

Use one library alias per configured component. The profile is JSON, not a new
workflow language. For example:

```robot
*** Settings ***
Library    treadway.widgets.WidgetLibrary    ${CDP_HOST}    ${CDP_PORT}    ${TARGET_ID}    ${ORIGIN}    ${PRIVATE_JOURNAL}    date_range    ${DATES_PROFILE}    WITH NAME    Dates

*** Test Cases ***
Prepare And Commit The Explicit Schedule
    ${snapshot}=    Dates.Inspect Widget
    ${values}=    Evaluate    {'start': '2026-12-07', 'due': '2026-12-11'}
    ${prepared}=    Dates.Prepare Widget Inputs    ${snapshot}    ${values}    explicit requested schedule
    Dates.Commit Widget Edit    ${prepared}
    Observe Bound Item Persistence
```

`DATES_PROFILE` contains the same `start`, `due`, `action` and `nativeForm` mapping
as the Node example. `Observe Bound Item Persistence` belongs to the site library.
Other keywords are `Open Inline Widget`, `Prepare Widget Choice`, `Select Widget
Option`, `Remove Widget Selection` and `Get Last Widget Result`. Choice selection
can take `option_selector` for an actual-ID-bound option. Multiselect JSON profiles
name a `selection` selector/data attribute and optional `removal` scope/data
attribute. Failed mechanics raise and stop subsequent native Robot keywords;
`Get Last Widget Result` retains the incomplete envelope and transport separately.
Allowing document transition is explicit and still does not prove persistence.

## React and Vue reuse boundary

The same operations run against real React 18.3.1 and Vue 3.5.45 fixtures. React's
controlled state and portals and Vue's `v-model`, watchers and Teleport are exercised
through actual browser input. Both fixtures submit actual component state to the
fixture server after a rerender; DOM readback alone is insufficient for those tests.
Core has no React Fiber, Vue instance or private component-state dependency.

A new site reuses input/action mechanics, controlled-choice checks, edit bindings,
request correlation, transfers and Robot transport. It still needs its selectors,
principal/resource/revision guards, request mapping, persistence observations and
cleanup. These fixtures do not establish compatibility with every version or
component kit. MUI, Ant Design, Element Plus and other library-specific profiles
would need their own pinned real fixtures and demonstrated mappings before being
advertised as supported.

## Verification

See the [validation history](../VALIDATION.md) for recorded calibration runs and
[fast feedback](../FAST-FEEDBACK.md) for current check commands. React/Vue fixtures
cover the documented interactions, not every component kit or external app.
