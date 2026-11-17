# Optimise a flow for the operator's objective

Start with what the operator wants done and the evidence they need. Read the
working flow and reuse its known routes, payload mappings and observers. Remove
work only when it is unnecessary for that objective.

| Objective | What may be shortened |
| --- | --- |
| Assign an owner and verify the saved value | A known HTTP operation can replace opening and editing a form. |
| Check that the editor rejects an invalid owner | Skip list navigation using a known item URL; keep the editor and invalid input. |
| Check that a creator cannot approve their own request | Reuse setup, but send the approval as the creator and check refusal and unchanged state. |

An API refusal does not answer a question about editor validation. Keep intended
users, input variations and expiry/anonymous conditions. Current identity and
resource checks still run where the objective requires them.

## Try both paths

From a generated project:

```sh
python optimise_flow.py --describe
python optimise_flow.py --bindings 100
CHROME_BIN=/absolute/path/to/chromium python optimise_flow.py --objective validation
```

`--describe` only prints the proposed steps. The 100-binding command runs a
journalled HTTP owner change against a disposable local app; it checks exactly
one write per binding despite expiry and a lost reply. The validation command
uses the browser to reject an invalid owner and checks that no write occurred.
Neither command accepts a live target. Each run prints a final JSON result and
keeps its evidence under `artifacts/`.

## Measure a candidate

```sh
CHROME_BIN=/absolute/path/to/chromium python optimise_flow.py --benchmark --repetitions 2
```

This runs both implementations on separate synthetic resources. It measures
cold and warm runs, checks the required evidence and reports saved time and
shared setup costs. It starts browsers and performs fixture mutations. Keep the
baseline; do not time a cached receipt as if it were a new execution.

For your own flow, make one small change, retain the required checks, and compare
matched runs. Run the smallest relevant failure checks before timing. A faster
candidate with missing evidence has not met the objective.

## Inspect existing runs offline

```sh
treadway-optimise profile artifacts/run/diagnostics/RUN_ID
treadway-optimise compare --objective artifacts/objective.json \
  --baseline artifacts/baseline-cold artifacts/baseline-warm \
  --candidate artifacts/candidate-cold artifacts/candidate-warm
```

These helpers read local records without running a flow. `compare` exits 0 when
the evidence qualifies, 1 when it fails or is incomplete, and 2 for invalid input.
A qualified candidate may still be slower.

Use the [comparison reference](OPTIMISATION-REFERENCE.md) for record schemas,
private operation labels, workload matching, transport changes and replay rules.
An uncertain write must be reconciled before any retry, including a switch from
HTTP to browser submission.
