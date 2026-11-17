# Reuse a mapped browser control

Use widget profiles for repeated interactions such as choosing an owner, editing
a date range or entering a note. Map the application's selectors once, then reuse
the profile across flows. React and Vue use the same public operations.

## Start with the working example

From a generated project:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite flow.robot
```

Expect two passed cases. Open `browser.cjs` to see owner selection, dates and a
plain-text note composed into one guarded save. `adapter.py` checks the user and
resource, then verifies the persisted values. [The walkthrough](../src/treadway/authoring/skill/treadway-flows/references/WALKTHROUGH.md)
traces these calls.

## Choose a helper

| Interaction | Reuse | Your mapping supplies |
| --- | --- | --- |
| Search and choose an option | `Autocomplete` | Field, readiness and actual option ID |
| Add or remove selections | `MultiSelect` | Exact selected IDs and removal controls |
| Enter start/due dates | `DateRange` | Text-input selectors and ordered ISO dates |
| Enter a literal note | `RichTextEditor` | Supported contenteditable host |
| Open an inline editor | `InlineEditor` | Explicit opening action and editor scope |
| Prepare and save a patch | `PreparedEdit` | Fields, action and current resource guard |
| Observe the save request | `RequestObserver` | Exact method/route and response interpretation |

Preparation changes inputs; commit checks them and sends one action. Your adapter
must still check current identity/revision and saved state. A matching label alone
does not prove the selected option's ID.

## Integrate a profile

Use [the Node composition example](reference/WIDGETS.md#node-composition) for a
date edit, or [the Robot example](reference/WIDGETS.md#native-robot-composition)
for `WidgetLibrary`. [Recipes](../src/treadway/authoring/skill/treadway-flows/references/RECIPES.md)
show autocomplete and request observation. Constructors are passive; mutations
require a private journal callback.

`DateRange` covers the documented text inputs, not every datepicker popup.
`RichTextEditor` enters plain text, not arbitrary rich document formats. Pinned
React/Vue fixtures do not establish support for every component kit. See
[profile contracts and coverage](reference/WIDGETS.md).
