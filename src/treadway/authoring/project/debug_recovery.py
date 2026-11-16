"""Runnable diagnostics walkthrough; synthetic loopback app, no external accounts."""
import argparse
import json
from pathlib import Path

from session_recovery import SessionRecoveryExample
from treadway.diagnostics import FlowChanged, RunDiagnostics
from treadway.recovery import OperationIncomplete


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--level', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'], default='INFO')
    parser.add_argument('--diagnostics-dir', default='artifacts/diagnostics')
    parser.add_argument('--no-console', action='store_true')
    parser.add_argument('--simulate-contract-change-at', type=int, choices=range(1, 101), metavar='1..100')
    args = parser.parse_args(argv)
    example = SessionRecoveryExample()
    result = {'outcome': 'unknown'}
    run = RunDiagnostics(args.diagnostics_dir, console=not args.no_console, level=args.level,
                        watch=[Path(__file__), Path(__file__).with_name('session_recovery.py')],
                        watch_runtime=True)
    try:
        with run:
            try:
                example.open_recovery_example()
                for number in range(1, 101):
                    if args.simulate_contract_change_at == number:
                        example.state['schemaVersion'] = 2  # Explicit local fixture simulation.
                    contract = example.executor.session.request('/contract').json()
                    run.check_contract('item-schema', expected=1, observed=contract['schemaVersion'])
                    receipt = example.executor.execute(f'item-{number}', '/items',
                        body={'id': f'item-{number}', 'value': number}, binding={'row': number})
                    if receipt['state'] != 'confirmed':
                        raise RuntimeError('fixture_effect_not_confirmed')
                result = {'outcome': 'confirmed', 'effects': example.verify_recovery_effects()}
            finally:
                example.close_recovery_example()
    except FlowChanged as error:
        result = {'outcome': 'stopped', 'code': 'flow_contract_changed', 'change': error.report}
    except OperationIncomplete as error:
        result = {'outcome': 'stopped', 'receipt': error.receipt}
    result['statistics'] = run.summary()
    result['diagnostics'] = str(run.directory)
    print(json.dumps(result), flush=True)
    return 0 if result['outcome'] == 'confirmed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
