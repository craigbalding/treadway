# A complete synthetic conversion

Run from the repository root:

```sh
python -m pip install -e '.[robot]'
python recorder/examples/http-first/walkthrough.py
```

The script starts an invented application on loopback, runs the native
[Robot suite](claims.robot), checks the exact request sequence, and shuts the
fixture down. Imports and constructors do not contact any application. Robot
reports go into a temporary directory and are removed after validation.

[capture.json](capture.json) is a handwritten minimal v2 event example plus
explicitly labelled selected flow projections. It is not a native SafeYolo
export, a full original-wire bundle, or application acceptance evidence.
`req-synthetic-save` joins the Save action's candidate response to a POST body;
the response returns `claim-captured`. `req-synthetic-read` joins the independent
GET observation for that same resource. Production conversion must retrieve the
full retained originals and check completeness before using such projections.

[ClaimLibrary.py](ClaimLibrary.py) checks those exact joins, then replaces the
captured amount, actor and resource ID with runtime bindings:

| Capture | Reusable operation |
| --- | --- |
| Candidate Save click and POST `/api/claims` | `Create Claim Once`, taking an explicit amount and a principal-bound HttpSession. |
| Demonstration account | Fresh actor per test; actual `/api/me` must match id and role inside the mutation operation. |
| Captured claim ID | New ID from this execution's complete 201 response. |
| Captured GET showing owner/amount | `Observe Persisted Claim`, a separate read-only GET checking the exact new record. |

The fixture uses an invented `X-Fixture-Actor` header solely to distinguish
synthetic sessions; the adapter refuses external origins. This is not a real
authentication mechanism. In an application adapter, substitute the calibrated
browser/cookie/token binding and principal endpoint, never this fixture header.
No captured credential is replayed. Both fresh personas create distinct records;
a mismatched actual principal sends only the probe and no mutation. The script
asserts exactly two POSTs, two fresh resource reads and that final failure probe.

An incomplete or unexpected mutation result stops execution for reconciliation;
the adapter never retries it. The readback must match independently before a
flow is counted as verified. The example demonstrates a baseline, not negative
validation or expiry testing; those require explicit separate operation choices.
