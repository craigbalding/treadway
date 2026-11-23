# Treadway Flow Recorder

A Chrome extension for driving each user journey of a web application by hand,
once, while it records a labelled trace. An agent then turns the trace into a
Treadway flow. This first version covers four things:

- **Test context.** Starting a journey declares a SafeYOLO test context, so
  SafeYOLO records the journey's HTTP traffic under that context in its flow
  store.
- **Personas.** Test users come from a `personas.json` file in a folder you
  choose. Identifiers such as PPSNs and test cards are generated from a seed, so
  each persona always gets the same values.
- **Fill all.** One button fills a form's empty fields from the persona. Fields
  the recorder cannot fill are highlighted for you.
- **Event log.** Clicks, submits, step markers and where each field value came
  from are saved to the folder when you stop.

The recorder does not capture HTTP traffic itself and adds no request headers.
HTTP detail comes from the SafeYOLO flow store, which you join to the event log
by the test context's `run` value.

## Requirements

- Chrome or Chromium 116 or later, using the SafeYOLO proxy. This is normally the
  browser on the SafeYOLO agent's desktop.
- A SafeYOLO policy whose `test_context` section lists the application's hosts
  and enables declared contexts:

  ```yaml
  addons:
    test_context:
      target_hosts:
        - "app.example.test"
      inject_declared: true
      declared_ttl_max: 1200   # seconds; SafeYOLO caps the recorder's timer at this value
  ```

  Without `inject_declared: true`, SafeYOLO accepts the declaration but does not
  apply it to the browser's requests.
- The SafeYOLO agent API key: the contents of `/app/agent_token` in the agent.
- Optional: a TypeSafe AI API key, used for Jev field classification. SafeYOLO
  policy must allow egress to `api.typesafe.ai`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this `recorder` folder.
3. Click the recorder's toolbar icon to open the side panel.

## Set up once per engagement

1. Make a folder that the agent can read and write, and put a `personas.json`
   in it (see [the example](examples/personas.json)).
2. In the side panel, open **Settings**:
   - **Choose folder** and select that folder. Chrome asks for read and write
     access. If Chrome later asks again, click **Reload personas**.
   - Paste the SafeYOLO agent API key.
   - List the target hosts exactly as in the SafeYOLO policy. `*.example.test`
     matches subdomains only.
   - Set the test context timer. The default is 20 minutes.
   - Optionally paste the TypeSafe AI API key.
3. Click **Save settings**.

Both keys are stored in this browser profile's extension storage.

## Record a journey

1. Pick a persona, type a journey name such as `submit expense claim`, and click
   **Start**. The recorder asks SafeYOLO which agent the key belongs to, then
   declares this context:

   ```text
   run=submit-expense-claim-20261123T101112Z;agent=<agent>;role=submitter;test=submit-expense-claim;persona=casey-submitter
   ```

   `run` is unique to this recording. `test` names the journey across
   recordings. `role` and `persona` show who did it.
2. Use the application normally. On a form, click **Fill all**. Add a step
   marker when the journey moves to a new stage. Click **Mark authenticated**
   once you are signed in.
3. If the timer runs out, SafeYOLO answers a target-host request with HTTP 428.
   The recorder then declares the same context again and shows a message.
   Resubmit the action yourself; the recorder does not retry it.
4. Click **Stop and save**. The recorder clears the SafeYOLO context and writes
   `journeys/<run>.json` into the folder. After stopping, requests to target
   hosts get HTTP 428 until you start another journey.

If the file cannot be written, the side panel keeps the journey. Click **Save
again** to retry, or **Discard** to drop it.

## How Fill all works

Fill all only fills empty fields in the top-level page. It works out what each
field expects in this order:

1. The `autocomplete` attribute, then the input type (`email` or `password`).
2. The field's name, id, label and placeholder.
3. Jev, if a TypeSafe key is set. All remaining fields go in one request.
   Answers with confidence below 0.6 are ignored.

Each value is set with the field's native value setter. The recorder then sends
`input` and `change` events and blurs the field, so React and similar frameworks
update their state. Fields are filled one at a time. After each one, the
recorder waits up to 1.5 seconds for the page to settle and then reads the value
back. Fields that appear during filling are handled in up to two more passes.

A field is highlighted in orange, for you to fill, when:

| Reason | Meaning |
| --- | --- |
| `unclassified` | Neither the rules nor Jev could tell what the field expects. |
| `secret` | A password or one-time code. These are never filled. |
| `no persona value` | The persona has no value for that type. |
| `no matching option` | No `select` option matches the persona's value. |
| `did not stick` | The page changed or rejected the value, or marked it invalid. |

The highlight clears when you type in the field.

### What is sent to Jev

Only field descriptions go to Jev: label, name, id, placeholder, input type,
autocomplete, nearby text and up to 20 `select` option labels. Persona values
are never sent.

## personas.json

```json
{
  "personas": [
    {
      "id": "casey-submitter",
      "role": "submitter",
      "label": "Casey Example",
      "facts": { "given_name": "Casey", "family_name": "Example", "email": "casey@example.test" },
      "generate": ["ppsn", "test_card"],
      "secrets": { "password": "CASEY_SUBMITTER_PASSWORD" }
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `id`, `role` | Required. Letters, digits and `_ . : -` only, because both go into the test context. |
| `label` | Name shown in the picker. Defaults to `id`. |
| `facts` | Fixed values, keyed by field type. Dates use `YYYY-MM-DD`. A text field whose placeholder or label shows `DD/MM/YYYY` or `MM/DD/YYYY` gets that layout. |
| `generate` | `ppsn`, `test_card` or both. |
| `seed` | Seed for generated values. Defaults to `id`. |
| `secrets` | Reference names for secrets, never the secrets themselves. Typed passwords are logged only as these names. |

The field types are `given_name`, `family_name`, `full_name`, `email`, `phone`,
`date_of_birth`, `address_line1`, `address_line2`, `city`, `region`,
`postcode`, `country`, `username`, `ppsn`, `card_number`, `card_name`,
`card_expiry`, `card_expiry_month`, `card_expiry_year`, `card_cvc`, `password`,
`new_password` and `one_time_code`. `full_name` and `card_name` default to the
given and family names. You can add other fact keys; Jev is offered them as
extra choices.

The generators produce:

- `ppsn`: a check-character-valid PPSN in the current format, such as `1234567FA`.
- `test_card`: a published Stripe test card number, an expiry of December three
  years ahead, and CVC `123`.

A fact of the same type overrides a generated value.

## Journey file

`journeys/<run>.json` has the format `treadway-journey-events/1`:

```json
{
  "format": "treadway-journey-events/1",
  "journey": "submit expense claim",
  "context": "run=...;agent=...;role=submitter;test=submit-expense-claim;persona=casey-submitter",
  "contextFields": { "run": "...", "agent": "...", "role": "submitter", "test": "...", "persona": "casey-submitter" },
  "persona": { "id": "casey-submitter", "role": "submitter", "label": "Casey Example", "secrets": { "password": "CASEY_SUBMITTER_PASSWORD" } },
  "startedAt": "...", "expiresAt": "...", "stoppedAt": "...",
  "events": [ { "at": "2026-11-23T10:11:13.001Z", "type": "click", "url": "...", "selectors": { } } ]
}
```

Each event has an `at` timestamp and a `type`:

| `type` | Contents |
| --- | --- |
| `context_declared`, `context_renewed`, `context_cleared`, `context_clear_failed` | SafeYOLO test context changes. `context_renewed` names the request that received the 428. |
| `page`, `navigation` | Page load (with title), or a `popstate` or `hashchange` in a single-page app. |
| `click` | The clicked element: `tag` and `selectors`. |
| `submit` | The form's `selectors`, plus the submit button's `submitter` selectors if there was one. |
| `field` | A change you made: `source: "human"`, `value`, and `fieldType` if the rules recognised it. Passwords and one-time codes have `redacted: true` and a `secretReference` instead of a value. |
| `fill` | Result of Fill all: `filled` entries (selectors, type, how it was classified, value, and source `persona` or `generated`) and `manual` entries (with reasons). |
| `marker` | `marker: "step"` with a `name`, or `marker: "authenticated"`. |

`selectors` gives several candidates: `testId`, `id`, `name`, `role` (role and
accessible name) and a short `css` path. The agent chooses the most stable one.

Events are recorded from every tab and frame in the browser while a journey is
running.

## Not in this version

Transparent retry after a 428, cross-role replay, autopilot, the coverage
checklist, observed-role checks and automated flow compilation. For now, an
agent builds flows from the journey file and the flow store, with your guidance.

## Tests

From the repository root:

```sh
npm run test:recorder
```

This runs the offline logic tests. If Playwright and the repository's
devDependencies (`npm ci --ignore-scripts`) are present, it also runs a browser
test. That test loads the unpacked extension in Chromium behind a fake SafeYOLO
proxy and records a journey through a synthetic React form, including a 428
renewal. If Playwright is missing, the browser test is skipped. Set
`RECORDER_PLAYWRIGHT` to load Playwright from another path.
