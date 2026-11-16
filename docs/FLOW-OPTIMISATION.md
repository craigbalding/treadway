# Optimise an existing flow

Use the operator's objective to choose the shortest safe execution that preserves
the required guarantees and evidence. This applies to carrying out work as well
as testing application behaviour. Existing application knowledge can remove
navigation and setup; current identity, resource and transaction checks remain
where the objective requires them. A testing objective additionally pins the
specific behaviour and boundary that must be exercised.

The [authoring skill and executable walkthrough](../src/treadway/authoring/skill/treadway-flows/references/OPTIMISATION.md)
cover the two offline helpers, comparison records, calibration and recovery.
The guide is also shipped as `treadway guide optimisation`.

```sh
treadway new my-flow
cd my-flow
python optimise_flow.py --describe
python optimise_flow.py --bindings 100
CHROME_BIN=/path/to/chromium python optimise_flow.py --objective validation
CHROME_BIN=/path/to/chromium python optimise_flow.py --benchmark
```

The same proven four-stage browser flow becomes an HTTP operation for assigning
ownership and verifying persistence, while testing editor validation retains the UI and the
original invalid input. Benchmarking performs separate synthetic transactions
and reports measured cold/warm timings, reuse costs and evidence coverage.
The [design](FLOW-OPTIMISATION-DESIGN.md) explains the architecture and boundaries.
