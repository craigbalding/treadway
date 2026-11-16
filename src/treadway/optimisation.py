"""Offline evidence and timing helpers for objective-directed flow authoring.

These records describe observations. They are never interpreted as execution
instructions. No application, browser, credential provider or journal is opened
for execution by this module.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import statistics


LIMIT = 4 * 1024 * 1024


def fingerprint(value):
    """Canonical identity for an objective or declared workload, not freshness."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    allow_nan=False).encode()).hexdigest()


def _read(path):
    path = Path(path)
    if path.stat().st_size > LIMIT:
        raise ValueError('bounded_analysis_record_required')
    return _decode(path.read_bytes())


def _decode(raw):
    if len(raw) > LIMIT:
        raise ValueError('bounded_analysis_record_required')
    value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('finite_json_required')))
    if not isinstance(value, dict):
        raise ValueError('analysis_object_required')
    return value


def _label(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value):
        raise ValueError('bounded_analysis_identifier_required')
    return value


def _number(value):
    if type(value) not in (float, int) or not math.isfinite(value) or not 0 <= value <= 10**12:
        raise ValueError('bounded_analysis_duration_required')
    return value


def _distribution(values):
    return {'samples': len(values), 'median_ms': statistics.median(values),
            'min_ms': min(values), 'max_ms': max(values), 'total_ms': sum(values)} if values else None


def _private_record(root, reference):
    """Read only an explicitly referenced file inside this run's directory."""
    if not isinstance(reference, dict) or not isinstance(reference.get('path'), str):
        raise ValueError('evidence_reference_required')
    path = (root / reference['path']).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('run_local_evidence_required')
    if path.stat().st_size > LIMIT:
        raise ValueError('bounded_evidence_required')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != reference.get('sha256'):
        raise ValueError('evidence_fingerprint_differs')
    value = _decode(raw)
    return value


def summarise_profile(run_directories):
    """Summarise retained diagnostics; optional links never reveal raw captures.

    Each input is a RunDiagnostics directory containing summary.json. An optional
    links.json, written by the consumer while that run is active, maps opaque
    references to short operation labels. Missing links give aggregate costs.
    """
    runs, groups = [], defaultdict(list)
    for directory in run_directories:
        root = Path(directory)
        summary = _read(root / 'summary.json')
        if summary.get('version') != 'treadway.run/1':
            raise ValueError('diagnostic_summary_required')
        run_id = _label(summary['run_id'])
        duration = _number(summary['duration_ms'])
        links = {}
        if (root / 'links.json').exists():
            index = _read(root / 'links.json')
            if index.get('version') != 'treadway.profile-links/1' or index.get('run_id') != run_id:
                raise ValueError('profile_link_run_differs')
            links = {_label(key): _label(value) for key, value in index['operations'].items()}
        operations = defaultdict(lambda: {'calls': 0, 'duration_ms': 0, 'cached_returns': 0})
        events = root / 'events.jsonl'
        if links and events.exists():
            with events.open() as stream:
                for line in stream:
                    if len(line) > 65536:
                        raise ValueError('bounded_diagnostic_event_required')
                    event = json.loads(line)
                    if event.get('run_id') != run_id:
                        raise ValueError('profile_event_run_differs')
                    label = links.get(event.get('operation_ref'))
                    if label and event.get('event') == 'operation_finished':
                        operation = operations[label]
                        operation['calls'] += 1
                        operation['duration_ms'] += _number(event.get('duration_ms', 0))
                        operation['cached_returns'] += event.get('cached') is True
        timings = {}
        for event, timing in summary.get('timings', {}).items():
            timings[_label(event)] = {key: _number(timing[key]) for key in ('count', 'total_ms', 'max_ms')}
        counts = {_label(key): _number(value) for key, value in summary.get('counts', {}).items()}
        entry = {'run_id': run_id, 'duration_ms': duration, 'outcome': summary.get('outcome'),
                 'telemetry_complete': summary.get('telemetry_complete') is True,
                 'counts': counts, 'timings': timings, 'operations': dict(operations),
                 'attribution': 'explicit_private_links' if links else 'aggregate_only'}
        runs.append(entry)
        groups['all'].append(duration)
    return {'version': 'treadway.profile/1', 'runs': runs, 'wall_time': _distribution(groups['all']),
            'limits': ['nested timings overlap', 'counts do not prove server effects',
                       'incomplete telemetry limits attribution, not retained outer elapsed time']}


def _objective(value):
    objective = _read(value) if isinstance(value, (str, Path)) else value
    if not isinstance(objective, dict) or objective.get('version') != 'treadway.objective/1':
        raise ValueError('testing_objective_required')
    _label(objective['id'])
    if type(objective.get('mutation')) is not bool:
        raise ValueError('explicit_mutation_boolean_required')
    if not isinstance(objective.get('question'), str) or not objective['question'].strip():
        raise ValueError('operator_testing_question_required')
    obligations = {}
    for entry in objective['obligations']:
        key = _label(entry['id'])
        if key in obligations:
            raise ValueError('unique_obligation_required')
        obligations[key] = _label(entry['boundary'])
    bindings = [_label(binding['id']) for binding in objective['workload']]
    if not obligations or not bindings or len(bindings) != len(set(bindings)):
        raise ValueError('unique_workload_and_obligations_required')
    for binding in objective['workload']:
        _label(binding['actor'])
    if not isinstance(objective.get('conditions'), dict):
        raise ValueError('intentional_conditions_required')
    challenges = [_label(item) for item in objective['required_challenges']]
    if len(challenges) != len(set(challenges)):
        raise ValueError('unique_challenges_required')
    if (not isinstance(objective.get('modes'), list) or not objective['modes']
            or any(mode not in {'cold', 'warm'} for mode in objective['modes'])
            or len(objective['modes']) != len(set(objective['modes']))):
        raise ValueError('declared_benchmark_modes_required')
    fingerprint(objective)  # Reject non-JSON and non-finite declared conditions.
    return objective, obligations, bindings


def _inspect_run(path, objective, obligations, bindings):
    path = Path(path)
    if path.is_dir():
        path = path / 'objective-run.json'
    run, issues = _read(path), []
    if run.get('version') != 'treadway.objective-run/1':
        raise ValueError('objective_run_required')
    run_id = _label(run['id'])
    if not isinstance(run.get('implementation_digest'), str) or not re.fullmatch(r'[0-9a-f]{64}', run['implementation_digest']):
        raise ValueError('implementation_fingerprint_required')
    if run.get('objective_digest') != fingerprint(objective):
        issues.append('objective_differs')
    if run.get('workload_digest') != fingerprint(objective['workload']):
        issues.append('workload_differs')
    if fingerprint(run.get('conditions')) != fingerprint(objective['conditions']):
        issues.append('intentional_conditions_differ')
    if run.get('outcome') != 'completed' or run.get('failure_kind'):
        issues.append('execution_incomplete')
    duration = _number(run['timing']['duration_ms'])
    convention = sorted({_label(value) for value in run['timing']['includes']})
    if not convention:
        raise ValueError('timing_convention_required')
    _number(run['timing'].get('calibration_ms', 0))
    scope = _label(run['transaction_scope'])
    contradicted = False
    seen = set()
    for entry in run.get('observations', []):
        key = (entry.get('binding'), entry.get('obligation'))
        if key in seen or key[0] not in bindings or key[1] not in obligations:
            issues.append('duplicate_or_unexpected_obligation')
            continue
        seen.add(key)
        try:
            observed = _private_record(path.parent, entry['evidence'])
            expected = {'version': 'treadway.objective-evidence/1', 'run_id': run_id,
                        'binding': key[0], 'obligation': key[1], 'boundary': obligations[key[1]]}
            if (any(observed.get(field) != value for field, value in expected.items())
                    or observed.get('complete') is not True or observed.get('current') is not True):
                issues.append('observation_context_incomplete')
                continue
            state = observed.get('state')
            if state == 'contradicted':
                contradicted = True
                issues.append('objective_contradicted')
            elif state != 'satisfied':
                issues.append('required_observation_unknown')
        except (OSError, ValueError, KeyError, TypeError):
            issues.append('observation_evidence_unavailable')
    if seen != {(binding, obligation) for binding in bindings for obligation in obligations}:
        issues.append('required_observation_missing')
    challenges = set()
    for entry in run.get('challenges', []):
        name = _label(entry['id'])
        if name in challenges:
            issues.append('duplicate_challenge')
        challenges.add(name)
        try:
            evidence = _private_record(path.parent, entry['evidence'])
            if (evidence.get('version') != 'treadway.challenge/1' or evidence.get('id') != name
                    or evidence.get('objective_digest') != fingerprint(objective)
                    or evidence.get('implementation_digest') != run.get('implementation_digest')
                    or evidence.get('subject') != run.get('subject') or not run.get('subject')
                    or not re.fullmatch(r'[0-9a-f]{64}', run.get('implementation_digest', ''))
                    or evidence.get('environment') != run.get('environment')
                    or evidence.get('state') != 'satisfied' or evidence.get('complete') is not True):
                issues.append('challenge_not_established')
        except (OSError, ValueError, KeyError, TypeError):
            issues.append('challenge_evidence_unavailable')
    if not set(objective['required_challenges']).issubset(challenges):
        issues.append('required_challenge_missing')
    transactions, transaction_ids = [], set()
    for entry in run.get('transactions', []):
        try:
            proof = _private_record(path.parent, entry['evidence'])
            if (proof.get('version') != 'treadway.transaction-evidence/1' or proof.get('run_id') != run_id
                    or proof.get('binding') != entry.get('binding') or proof.get('scope') != scope
                    or proof.get('intent_digest') != entry.get('intent_digest')
                    or not re.fullmatch(r'[0-9a-f]{64}', entry.get('intent_digest', ''))):
                issues.append('transaction_provenance_differs')
            receipt = proof['receipt']
            if receipt.get('operation_id') != entry.get('operation_id'):
                issues.append('transaction_identity_differs')
            key = (_label(entry['scope']), _label(receipt['operation_id']))
            if entry['scope'] != scope or key in transaction_ids or entry.get('binding') not in bindings:
                issues.append('transaction_binding_differs')
            transaction_ids.add(key)
            if receipt.get('cached') is not False:
                issues.append('historical_receipt_is_not_fresh_execution')
            if receipt.get('unresolved_effect') is not False or receipt.get('state') not in {'confirmed', 'rejected', 'not_dispatched'}:
                issues.append('transaction_effect_unresolved')
            transactions.append({'binding': entry.get('binding'), 'scope': key[0], 'operation_id': key[1],
                                 'state': receipt.get('state'), 'dispatches': receipt.get('dispatches')})
        except (OSError, ValueError, KeyError, TypeError):
            issues.append('transaction_evidence_unavailable')
    if objective.get('mutation') is True and {item['binding'] for item in transactions} != set(bindings):
        issues.append('tested_transaction_missing')
    samples = run.get('binding_durations_ms', [])
    if len(samples) != len(bindings):
        issues.append('binding_timing_missing')
    samples = [_number(value) for value in samples]
    shared = run['timing'].get('shared_costs')
    if run['mode'] == 'warm':
        if not isinstance(shared, dict):
            issues.append('shared_reuse_costs_missing')
        else:
            _label(shared['group'])
            _number(shared['preparation_ms'])
            _number(shared['teardown_ms'])
            if type(shared.get('samples')) is not int or shared['samples'] < 1:
                raise ValueError('shared_sample_count_required')
    return {'id': run_id, 'variant': _label(run['variant']), 'pair': _label(run['pair']),
            'subject': _label(run['subject']), 'implementation_digest': run['implementation_digest'],
            'mode': _label(run['mode']), 'environment': _label(run['environment']),
            'scope': scope, 'timing_convention': convention, 'duration_ms': duration,
            'faults': run.get('faults', {}),
            'calibration_ms': run['timing'].get('calibration_ms', 0),
            'shared_costs': shared,
            'per_binding': _distribution(samples), 'transactions': transactions,
            'issues': sorted(set(issues)), 'verdict': 'failed' if contradicted else 'incomplete' if issues else 'passed'}


def compare_objective_runs(objective, baseline_runs, candidate_runs):
    """Check supplied domain evidence coverage and compare matched executions.

    Domain observers own semantic correctness. This helper verifies their bound,
    fingerprinted evidence, not whether the application implements those claims.
    An empty or incomplete comparison never qualifies a candidate.
    """
    objective, obligations, bindings = _objective(objective)
    baseline = [_inspect_run(path, objective, obligations, bindings) for path in baseline_runs]
    candidate = [_inspect_run(path, objective, obligations, bindings) for path in candidate_runs]
    issues, modes = [], {}
    if not baseline or not candidate:
        issues.append('matched_executions_required')
    all_runs = baseline + candidate
    if len({run['id'] for run in all_runs}) != len(all_runs):
        issues.append('duplicate_run')
    if set(run['variant'] for run in baseline) & set(run['variant'] for run in candidate):
        issues.append('distinct_candidates_required')
    if len({run['environment'] for run in all_runs}) > 1:
        issues.append('benchmark_conditions_differ')
    for side in (baseline, candidate):
        if len({(run['variant'], run['implementation_digest'], run['subject']) for run in side}) > 1:
            issues.append('mixed_implementations')
    if objective.get('mutation') is True and len({run['scope'] for run in all_runs}) != len(all_runs):
        issues.append('separate_benchmark_transactions_required')
    pairs = Counter((run['mode'], run['pair']) for run in baseline)
    other = Counter((run['mode'], run['pair']) for run in candidate)
    if pairs != other or any(value != 1 for value in pairs.values()):
        issues.append('matched_pairs_required')
    if set(run['mode'] for run in baseline) != set(objective['modes']) or set(run['mode'] for run in candidate) != set(objective['modes']):
        issues.append('declared_benchmark_mode_missing')
    for mode in sorted({run['mode'] for run in all_runs}):
        if len({tuple(run['timing_convention']) for run in all_runs if run['mode'] == mode}) > 1:
            issues.append('benchmark_conditions_differ')
        if len({fingerprint(run['faults']) for run in all_runs if run['mode'] == mode}) > 1:
            issues.append('fault_workload_differs')
        left = [run['duration_ms'] for run in baseline if run['mode'] == mode]
        right = [run['duration_ms'] for run in candidate if run['mode'] == mode]
        modes[mode] = {'baseline': _distribution(left), 'candidate': _distribution(right)}
        for label, side in (('baseline', baseline), ('candidate', candidate)):
            selected = [run for run in side if run['mode'] == mode]
            shared = {}
            for run in selected:
                if run['shared_costs']:
                    group = run['shared_costs']['group']
                    if group in shared and shared[group] != run['shared_costs']:
                        issues.append('shared_cost_record_differs')
                    shared[group] = run['shared_costs']
            for group, value in shared.items():
                if sum(run['shared_costs'] is not None and run['shared_costs']['group'] == group for run in selected) != value['samples']:
                    issues.append('shared_sample_count_differs')
            extra = sum(value['preparation_ms']+value['teardown_ms'] for value in shared.values())
            values = modes[mode][label]
            if values:
                values['shared_preparation_and_teardown_ms'] = extra
                values['amortised_ms_per_run'] = (values['total_ms']+extra)/values['samples']
                values['calibration_ms'] = max(run['calibration_ms'] for run in selected)
                values['amortised_ms_per_binding'] = (values['total_ms']+extra)/(values['samples']*len(bindings))
    verdict = 'failed' if any(run['verdict'] == 'failed' for run in all_runs) else (
        'incomplete' if issues or any(run['issues'] for run in all_runs) else 'qualified')
    if verdict == 'qualified':
        for mode, values in modes.items():
            left, right = values['baseline']['median_ms'], values['candidate']['median_ms']
            values['median_saved_ms'] = left - right
            values['speedup'] = left / right if right > 0 else None
    return {'version': 'treadway.comparison/1', 'objective': objective['id'], 'verdict': verdict,
            'issues': issues, 'baseline': baseline, 'candidate': candidate, 'modes': modes,
            'limits': ['domain observers establish business truth', 'qualified does not imply faster',
                       'cached receipts are historical; setup reuse is distinct from fresh tested actions']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    profile = commands.add_parser('profile', help='Summarise retained diagnostics without executing a flow')
    profile.add_argument('runs', nargs='+', type=Path)
    compare = commands.add_parser('compare', help='Compare matched runs against an operational or testing objective')
    compare.add_argument('--objective', required=True, type=Path)
    compare.add_argument('--baseline', required=True, nargs='+', type=Path)
    compare.add_argument('--candidate', required=True, nargs='+', type=Path)
    args = parser.parse_args(argv)
    try:
        result = summarise_profile(args.runs) if args.command == 'profile' else compare_objective_runs(
            args.objective, args.baseline, args.candidate)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f'Analysis record invalid ({type(error).__name__}); inspect the private input records.\n')
    print(json.dumps(result, allow_nan=False))
    return 0 if args.command == 'profile' or result['verdict'] == 'qualified' else 1


if __name__ == '__main__':
    raise SystemExit(main())
