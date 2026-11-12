#!/usr/bin/env bash
# Run from anywhere with a fresh wheel installation active and CHROME_BIN set.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/treadway-installed.XXXXXXXX")
printf 'Installed-runtime evidence directory: %s\n' "$scratch"
cd "$scratch"
unset PYTHONPATH
export FORM_BROWSER_MODULE_ROOT
FORM_BROWSER_MODULE_ROOT=$(python -c 'from pathlib import Path; import treadway; print(Path(treadway.__file__).parent / "browser")')
case "$FORM_BROWSER_MODULE_ROOT" in
  "$repo"/*) echo 'Expected a wheel installation outside the checkout' >&2; exit 1 ;;
esac
export FORM_REACT_FIXTURE_ROOT="$repo"
export TREADWAY_PYTHON
TREADWAY_PYTHON=$(command -v python)
export FORM_ROBOT_PYTHON="$TREADWAY_PYTHON"
test -x "$CHROME_BIN"
"$CHROME_BIN" --version
python -c 'import robot; assert robot.__version__ == "7.5.1"'
npm ci --ignore-scripts --prefix "$FORM_BROWSER_MODULE_ROOT"
python -m pytest --basetemp "$scratch/pytest" --import-mode=importlib -q "$repo/tests"
# Absolute test paths and an external working directory exercise installed JS.
node --test --test-concurrency=1 "$repo"/tests/test_*_browser.js
treadway guide start > /dev/null
treadway skill "$scratch/standalone-skill"
treadway new "$scratch/walkthrough"
cd "$scratch/walkthrough"
python run.py check
for suite in flow.robot handoff.robot collaboration.robot; do
  python run.py test --suite "$suite"
done
# Leave scratch in place on failure so the runner log identifies the evidence.
rm -rf -- "$scratch"
