"""Execute the exported objective examples and inspect actual fixture effects."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

import pytest

from treadway.authoring import main
from treadway.optimisation import compare_objective_runs, summarise_profile
from treadway.recovery import OperationIncomplete


@pytest.fixture
def example(tmp_path, monkeypatch):
    project = tmp_path/'owner example'
    main(['new', str(project)])
    monkeypatch.syspath_prepend(str(project))
    monkeypatch.delitem(sys.modules, 'optimisation_fixture', raising=False)
    spec = importlib.util.spec_from_file_location('optimisation_example', project/'optimise_flow.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, project


def test_objective_selects_omissions_and_describe_stays_passive(example, monkeypatch):
    module, project = example
    monkeypatch.setattr(socket, 'create_connection', lambda *a, **k: pytest.fail('passive inspection contacted application'))
    context = module.Context(project/'unused', 2)
    assert context.fixture.server is None and not (project/'unused').exists()
    persistence, validation = module.disposition('persistence'), module.disposition('validation')
    assert persistence[2]['decision'] == 'construct-bound-payload'
    assert validation[2]['decision'] == 'retain-browser-input'
    for flag in ['--help', '--describe']:
        result = subprocess.run([sys.executable, 'optimise_flow.py', flag], cwd=project,
                                text=True, capture_output=True, timeout=5)
        assert result.returncode == 0, result.stderr
    assert not (project/'artifacts').exists()


def test_explicit_fault_gates_preserve_unknown_effect_and_intentional_anonymous_request(example, tmp_path):
    module, _ = example
    objective = module.testing_objective('persistence', 2)
    objective['required_challenges'].append('intentional-authentication')
    gates = module.challenge_contracts(tmp_path/'faults', objective)
    assert set(gates['gates']) == set(objective['required_challenges'])
    assert all(gate['state'] == 'satisfied' for gate in gates['gates'].values())
    lost = gates['gates']['lost-response']['facts']
    assert (lost['writes'], lost['attempts'], lost['receipt']['state']) == (1, 1, 'confirmed')
    anonymous = gates['gates']['intentional-authentication']['facts']
    assert (anonymous['writes'], anonymous['attempts'], anonymous['receipt']['state']) == (0, 1, 'rejected')


def test_100_bound_mutations_with_two_actors_expiry_and_lost_response(example, tmp_path):
    module, _ = example
    objective = module.testing_objective('persistence', 100)
    gates = module.challenge_contracts(tmp_path/'faults', objective)
    directory, result = module.run_sample(tmp_path/'runs', objective, 'candidate', 'cold', 'one', gates,
                                         expire_after=37, lose_response='item-63')
    assert result['outcome'] == 'completed', result
    assert result['fixture_counts'] == {'writes': 100, 'refreshes': 1, 'lost': True}
    assert len(result['transactions']) == 100 and len(result['observations']) == 300
    assert all(json.loads((directory/entry['evidence']['path']).read_text())['receipt']['state'] == 'confirmed'
               for entry in result['transactions'])
    diagnostic, = (directory/'diagnostics').iterdir()
    profile = summarise_profile([diagnostic])['runs'][0]
    assert profile['counts']['dispatch_reservations'] == 100
    assert profile['counts']['authentication_renewals'] == 1
    assert profile['operations']['save-owner']['calls'] == 100
    assert not list(directory.rglob('DevToolsActivePort'))


def test_unknown_transaction_cannot_be_replaced_with_browser_fallback(example, tmp_path):
    module, _ = example
    fixture = module.OwnerFixture(tmp_path/'fixture', 1, lose_response='item-1').start()
    try:
        executor = fixture.executor('member-a', tmp_path/'executor', reconcile=False)
        arguments = {'body': {'id': 'item-1', 'owner': 'owner-b', 'revision': 1},
                     'binding': {'id': 'item-1'}, 'method': 'PATCH', 'headers': {'If-Match': '1'}}
        with pytest.raises(OperationIncomplete) as first:
            executor.execute('original', '/items/item-1', **arguments)
        with pytest.raises(OperationIncomplete) as second:
            executor.execute('original', '/items/item-1', **arguments)
        assert first.value.receipt['unresolved_effect'] and second.value.receipt['unresolved_effect']
        assert fixture.state['writes'] == 1 and len(fixture.state['attempts']) == 1
        with pytest.raises(ValueError, match='original_browser_intent_differs'):
            directory = tmp_path/'reservation'
            module.private_json(directory/'original-intent.json', {'operation_id': 'different'}, exclusive=True)
            module.browser_binding(None, {'actor': 'member-a', 'item': 'item-1', 'values': {}},
                                   'original', None, directory, direct=True, objective='persistence')
        assert len(fixture.state['attempts']) == 1
    finally:
        fixture.close()


def test_owned_cleanup_error_cannot_leave_a_completed_run(example, tmp_path, monkeypatch):
    module, _ = example
    objective = module.testing_objective('persistence', 1)
    gates = module.challenge_contracts(tmp_path/'faults', objective)
    original = module.Context.close
    def incomplete(context):
        original(context)
        raise RuntimeError('synthetic teardown failure')
    monkeypatch.setattr(module.Context, 'close', incomplete)
    directory, record = module.run_sample(tmp_path/'runs', objective, 'candidate', 'cold', 'one', gates)
    assert record['outcome'] == 'incomplete' and record['failure_kind'] == 'RuntimeError'
    assert json.loads((directory/'objective-run.json').read_text())['outcome'] == 'incomplete'


@pytest.mark.skipif(not os.environ.get('CHROME_BIN'), reason='CHROME_BIN required for actual UI boundary')
def test_browser_baseline_and_ui_validation_candidate_exercise_real_editor(example, tmp_path):
    module, _ = example
    for objective_name in ('persistence', 'validation'):
        objective = module.testing_objective(objective_name, 1)
        baseline_gates = module.challenge_contracts(tmp_path/(objective_name+'-baseline-faults'), objective, 'browser-list')
        candidate_gates = module.challenge_contracts(tmp_path/(objective_name+'-candidate-faults'), objective,
            'http' if objective_name == 'persistence' else 'browser-direct')
        left, baseline = module.run_sample(tmp_path/objective_name, objective, 'baseline', 'cold', 'one', baseline_gates)
        right, candidate = module.run_sample(tmp_path/objective_name, objective, 'candidate', 'cold', 'one', candidate_gates)
        assert baseline['outcome'] == candidate['outcome'] == 'completed', (baseline, candidate)
        comparison = compare_objective_runs(objective, [left], [right])
        assert comparison['verdict'] == 'qualified', comparison
        if objective_name == 'validation':
            assert baseline['fixture_counts']['writes'] == candidate['fixture_counts']['writes'] == 0
            assert (right/'browser.jsonl').exists()
        else:
            assert baseline['fixture_counts']['writes'] == candidate['fixture_counts']['writes'] == 1
            assert not (right/'browser.jsonl').exists()


@pytest.mark.skipif(not os.environ.get('CHROME_BIN'), reason='CHROME_BIN required for matched cold/warm measurements')
def test_exported_benchmark_records_matched_cold_and_warm_samples(example, tmp_path):
    _, project = example
    result = subprocess.run([sys.executable, 'optimise_flow.py', '--benchmark', '--repetitions', '1',
                             '--bindings', '1', '--output', str(tmp_path/'measurement')],
                            cwd=project, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout+result.stderr
    comparison = json.loads(result.stdout)
    assert comparison['verdict'] == 'qualified'
    assert set(comparison['modes']) == {'cold', 'warm'}
    for mode in comparison['modes'].values():
        assert mode['baseline']['samples'] == mode['candidate']['samples'] == 1
        assert mode['baseline']['median_ms'] > 0 and mode['candidate']['median_ms'] > 0
    root = Path(comparison['artifacts'])
    assert (root/'profile.json').exists() and (root/'knowledge.json').exists()
    knowledge = json.loads((root/'knowledge.json').read_text())
    assert len(knowledge['implementation_digest']) == 64
    assert knowledge['claims'][0]['operation'] == 'owner-write'
