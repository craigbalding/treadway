"""Offline analysis consumes real bound files, never treats status as proof."""
import copy
import hashlib
import json
import subprocess
import sys

import pytest

from treadway.optimisation import compare_objective_runs, fingerprint, summarise_profile


def objective():
    return {'version': 'treadway.objective/1', 'id': 'creator-refusal',
            'question': 'Does the application refuse creator approval?',
            'conditions': {'authentication': 'creator', 'renewal': 'disabled'},
            'obligations': [{'id': 'application-refusal', 'boundary': 'application'},
                            {'id': 'unchanged', 'boundary': 'persistence'}],
            'workload': [{'id': 'item-1', 'actor': 'member-a', 'values': {'revision': 1}}],
            'mutation': True, 'modes': ['cold'], 'required_challenges': ['lost-response']}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value).encode()
    path.write_bytes(data)
    return {'path': path.name, 'sha256': hashlib.sha256(data).hexdigest()}


def sample(root, variant, spec=None, duration=100):
    spec = spec or objective()
    root.mkdir(parents=True)
    record = {'version': 'treadway.objective-run/1', 'id': root.name,
              'variant': variant, 'pair': 'one', 'mode': 'cold', 'environment': 'synthetic-v1',
              'outcome': 'completed', 'objective_digest': fingerprint(spec),
              'implementation_digest': 'a'*64, 'subject': variant, 'transaction_scope': root.name,
              'workload_digest': fingerprint(spec['workload']), 'conditions': spec['conditions'],
              'timing': {'duration_ms': duration, 'includes': ['setup', 'execution', 'checks', 'teardown']},
              'binding_durations_ms': [duration/2], 'observations': [], 'challenges': [], 'transactions': []}
    for obligation in spec['obligations']:
        evidence = {'version': 'treadway.objective-evidence/1', 'run_id': root.name,
                    'binding': 'item-1', 'obligation': obligation['id'], 'boundary': obligation['boundary'],
                    'state': 'satisfied', 'complete': True, 'current': True,
                    'facts': {'status': 403, 'writes': 0}}
        ref = write(root / (obligation['id']+'.json'), evidence)
        record['observations'].append({'binding': 'item-1', 'obligation': obligation['id'], 'evidence': ref})
    gate = {'version': 'treadway.challenge/1', 'id': 'lost-response', 'complete': True,
            'objective_digest': fingerprint(spec), 'implementation_digest': 'a'*64,
            'environment': 'synthetic-v1', 'subject': variant, 'state': 'satisfied'}
    record['challenges'].append({'id': 'lost-response', 'evidence': write(root/'challenge.json', gate)})
    receipt = {'operation_id': 'approval-1', 'state': 'rejected', 'cached': False,
               'unresolved_effect': False, 'dispatches': 1}
    proof = {'version': 'treadway.transaction-evidence/1', 'run_id': root.name,
             'binding': 'item-1', 'scope': root.name, 'intent_digest': 'c'*64, 'receipt': receipt}
    record['transactions'].append({'binding': 'item-1', 'scope': root.name, 'operation_id': 'approval-1',
                                   'intent_digest': 'c'*64, 'evidence': write(root/'receipt.json', proof)})
    write(root/'objective-run.json', record)
    return root, record


def test_negative_objective_passes_with_rejected_effect_and_independent_evidence(tmp_path):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, _ = sample(tmp_path/'candidate', 'http', duration=30)
    report = compare_objective_runs(objective(), [left], [right])
    assert report['verdict'] == 'qualified'
    assert report['modes']['cold']['median_saved_ms'] == 70
    assert report['candidate'][0]['transactions'][0]['state'] == 'rejected'


@pytest.mark.parametrize('change,reason', [
    ('missing', 'required_observation_missing'), ('boundary', 'observation_context_incomplete'),
    ('old', 'observation_context_incomplete'), ('unknown', 'required_observation_unknown'),
    ('truncated', 'observation_context_incomplete'), ('edited', 'observation_evidence_unavailable'),
    ('escape', 'observation_evidence_unavailable'), ('cached', 'historical_receipt_is_not_fresh_execution'),
    ('unresolved', 'transaction_effect_unresolved'), ('gate', 'challenge_not_established'),
    ('conditions', 'intentional_conditions_differ'), ('workload', 'workload_differs'),
    ('duplicate', 'duplicate_or_unexpected_obligation'), ('receipt-missing', 'tested_transaction_missing')])
def test_fast_but_invalid_candidates_never_qualify(tmp_path, change, reason):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, record = sample(tmp_path/'candidate', 'http', duration=1)
    if change == 'missing':
        record['observations'].pop()
    elif change == 'duplicate':
        record['observations'].append(record['observations'][0])
    elif change == 'receipt-missing':
        record['transactions'] = []
    elif change in {'boundary', 'old', 'unknown', 'truncated', 'edited'}:
        entry = record['observations'][0]
        path = right/entry['evidence']['path']
        data = json.loads(path.read_text())
        changes = {'boundary': {'boundary': 'local-guard'}, 'old': {'current': False},
                   'unknown': {'state': 'unknown'}, 'truncated': {'complete': False},
                   'edited': {'facts': {'status': 200}}}
        data.update(changes[change])
        ref = write(path, data)
        if change != 'edited':
            entry['evidence'] = ref
    elif change == 'escape':
        record['observations'][0]['evidence'] = write(tmp_path/'outside.json', {'state': 'satisfied'}) | {'path': '../outside.json'}
    elif change in {'cached', 'unresolved'}:
        receipt = json.loads((right/'receipt.json').read_text())
        receipt['receipt'].update({'cached': True} if change == 'cached' else {'state': 'unknown', 'unresolved_effect': True})
        record['transactions'][0]['evidence'] = write(right/'receipt.json', receipt)
    elif change == 'gate':
        gate = json.loads((right/'challenge.json').read_text())
        gate['id'] = 'some-other-gate'
        record['challenges'][0]['evidence'] = write(right/'challenge.json', gate)
    elif change == 'conditions':
        record['conditions'] = {'authentication': 'different-user'}
    elif change == 'workload':
        record['workload_digest'] = 'b'*64
    write(right/'objective-run.json', record)
    report = compare_objective_runs(objective(), [left], [right])
    assert report['verdict'] == 'incomplete'
    assert reason in report['candidate'][0]['issues']
    assert 'speedup' not in report['modes']['cold']


def test_actual_contradiction_is_a_failed_objective(tmp_path):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, record = sample(tmp_path/'candidate', 'http')
    evidence = json.loads((right/'application-refusal.json').read_text())
    evidence['state'] = 'contradicted'
    record['observations'][0]['evidence'] = write(right/'application-refusal.json', evidence)
    write(right/'objective-run.json', record)
    assert compare_objective_runs(objective(), [left], [right])['verdict'] == 'failed'


def test_previous_first_execution_receipt_cannot_be_relabelled_as_a_new_transaction(tmp_path):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, record = sample(tmp_path/'candidate', 'http')
    old = json.loads((left/'receipt.json').read_text())
    record['transactions'][0]['evidence'] = write(right/'receipt.json', old)
    write(right/'objective-run.json', record)
    report = compare_objective_runs(objective(), [left], [right])
    assert report['verdict'] == 'incomplete'
    assert 'transaction_provenance_differs' in report['candidate'][0]['issues']


def test_challenge_must_match_the_actual_implementation_subject(tmp_path):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, record = sample(tmp_path/'candidate', 'http')
    gate = json.loads((right/'challenge.json').read_text())
    gate['subject'] = 'browser'
    record['challenges'][0]['evidence'] = write(right/'challenge.json', gate)
    write(right/'objective-run.json', record)
    assert 'challenge_not_established' in compare_objective_runs(objective(), [left], [right])['candidate'][0]['issues']


def test_execution_error_and_unequal_fault_workloads_invalidate_comparison(tmp_path):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, record = sample(tmp_path/'candidate', 'http')
    record.update(failure_kind='TeardownIncomplete', faults={'expire_after': 37})
    write(right/'objective-run.json', record)
    result = compare_objective_runs(objective(), [left], [right])
    assert result['verdict'] == 'incomplete' and 'fault_workload_differs' in result['issues']
    assert 'execution_incomplete' in result['candidate'][0]['issues']


def test_different_candidate_versions_cannot_be_pooled_into_one_speed_claim(tmp_path):
    left, first = sample(tmp_path/'baseline', 'browser')
    left2, second = sample(tmp_path/'baseline2', 'browser')
    right, third = sample(tmp_path/'candidate', 'http')
    right2, fourth = sample(tmp_path/'candidate2', 'http-v2')
    second['pair'] = fourth['pair'] = 'two'
    write(left2/'objective-run.json', second)
    write(right2/'objective-run.json', fourth)
    result = compare_objective_runs(objective(), [left, left2], [right, right2])
    assert result['verdict'] == 'incomplete' and 'mixed_implementations' in result['issues']


def test_warm_measurements_report_actual_shared_costs_and_require_complete_group(tmp_path):
    spec = objective()
    spec['modes'] = ['warm']
    left, first = sample(tmp_path/'baseline', 'browser', spec)
    right, second = sample(tmp_path/'candidate', 'http', spec, duration=20)
    for directory, record in ((left, first), (right, second)):
        record['mode'] = 'warm'
        record['timing']['includes'] = ['execution', 'checks']
        record['timing']['shared_costs'] = {'group': directory.name, 'preparation_ms': 100,
                                          'teardown_ms': 10, 'samples': 1}
        write(directory/'objective-run.json', record)
    result = compare_objective_runs(spec, [left], [right])
    assert result['verdict'] == 'qualified'
    assert result['modes']['warm']['candidate']['amortised_ms_per_run'] == 130
    second['timing']['shared_costs']['samples'] = 2
    write(right/'objective-run.json', second)
    assert 'shared_sample_count_differs' in compare_objective_runs(spec, [left], [right])['issues']


@pytest.mark.parametrize('flag', ['true', 1, None])
def test_invalid_mutation_flag_is_rejected_instead_of_disabling_transaction_checks(flag):
    spec = objective()
    spec['mutation'] = flag
    with pytest.raises(ValueError, match='explicit_mutation_boolean_required'):
        compare_objective_runs(spec, [], [])


def test_implementation_fingerprint_required_even_without_challenges(tmp_path):
    spec = objective()
    spec['required_challenges'] = []
    left, _ = sample(tmp_path/'baseline', 'browser', spec)
    right, record = sample(tmp_path/'candidate', 'http', spec)
    record['implementation_digest'] = None
    write(right/'objective-run.json', record)
    with pytest.raises(ValueError, match='implementation_fingerprint_required'):
        compare_objective_runs(spec, [left], [right])


def test_benchmark_conditions_and_empty_or_unmatched_runs_are_explicit(tmp_path):
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, record = sample(tmp_path/'candidate', 'http')
    record.update(transaction_scope='baseline', pair='another')
    record['timing']['includes'].remove('teardown')
    write(right/'objective-run.json', record)
    report = compare_objective_runs(objective(), [left], [right])
    assert set(report['issues']) >= {'matched_pairs_required', 'benchmark_conditions_differ',
                                     'separate_benchmark_transactions_required'}
    assert compare_objective_runs(objective(), [], [])['verdict'] == 'incomplete'
    more = copy.deepcopy(objective())
    more['modes'].append('warm')
    assert 'declared_benchmark_mode_missing' in compare_objective_runs(more, [left], [right])['issues']


def test_profile_links_are_explicit_and_incomplete_telemetry_does_not_erase_elapsed_time(tmp_path):
    from treadway.diagnostics import RunDiagnostics, reference, span
    with RunDiagnostics(tmp_path/'runs') as run:
        ref = reference('synthetic-operation')
        with span('operation', operation_ref=ref):
            pass
        write(run.directory/'links.json', {'version': 'treadway.profile-links/1', 'run_id': run.id,
                                         'operations': {ref: 'save-owner'}})
    result = summarise_profile([run.directory])
    assert result['runs'][0]['operations']['save-owner']['calls'] == 1
    (run.directory/'links.json').unlink()
    summary = json.loads((run.directory/'summary.json').read_text())
    summary['telemetry_complete'] = False
    write(run.directory/'summary.json', summary)
    result = summarise_profile([run.directory])
    assert result['wall_time']['median_ms'] > 0
    assert result['runs'][0]['attribution'] == 'aggregate_only'
    assert not result['runs'][0]['telemetry_complete']


def test_analysis_cli_and_import_are_passive_and_do_not_change_evidence(tmp_path, monkeypatch):
    import socket
    monkeypatch.setattr(socket, 'create_connection', lambda *a, **k: pytest.fail('offline helper made a connection'))
    left, _ = sample(tmp_path/'baseline', 'browser')
    right, _ = sample(tmp_path/'candidate', 'http')
    before = {path: path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    assert compare_objective_runs(objective(), [left], [right])['verdict'] == 'qualified'
    assert before == {path: path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    result = subprocess.run([sys.executable, '-m', 'treadway.optimisation', '--help'],
                            cwd=tmp_path, capture_output=True, text=True, timeout=5)
    assert result.returncode == 0 and 'compare' in result.stdout
