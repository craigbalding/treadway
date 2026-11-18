"""Exported runners consume native Robot results and shared scoped receipts."""
import io
import json
import runpy
import time

import pytest
from robot.api import TestSuite as RobotSuite

from treadway.authoring import ASSETS


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(ASSETS / 'project'))
    return runpy.run_path(str(ASSETS / 'project/run.py'))


@pytest.mark.parametrize('keyword,accepted', [('No Operation', True), ('Fail', False), ('Skip', False)])
def test_native_robot_result_accepts_only_all_passed_nested_tests(tmp_path, runner, keyword, accepted):
    suite = RobotSuite('Parent')
    nested = suite.suites.create('Child')
    nested.tests.create('Observed result').body.create_keyword(name=keyword)
    output = tmp_path / 'output.xml'
    suite.run(output=str(output), log='NONE', report='NONE', stdout=io.StringIO())
    if accepted:
        assert runner['robot_pass_count'](output) == 1
    else:
        with pytest.raises(RuntimeError, match='robot_acceptance_incomplete'):
            runner['robot_pass_count'](output)


def test_missing_or_truncated_robot_result_cannot_pass(tmp_path, runner):
    output = tmp_path / 'output.xml'
    with pytest.raises(Exception):
        runner['robot_pass_count'](output)
    output.write_text('<robot><suite>')
    with pytest.raises(Exception):
        runner['robot_pass_count'](output)


def test_native_robot_result_with_no_tests_cannot_pass(tmp_path, runner):
    output = tmp_path / 'empty.xml'
    RobotSuite('Empty').run(output=str(output), log='NONE', report='NONE', stdout=io.StringIO())
    with pytest.raises(RuntimeError, match='robot_acceptance_incomplete'):
        runner['robot_pass_count'](output)


def worker(output, root, run, *, project='expected-project', mode='fresh', cleanup=None, tail=b'', unknown=False):
    directory = output / root / run
    directory.mkdir(parents=True, mode=0o700)
    actor = {'actor': 'member', 'generation': 'generation-one'}
    events = [{'kind': 'worker_started', 'projectId': project, 'runId': run},
              {'kind': 'acquisition_intent', 'mode': mode, **actor}]
    if unknown:
        events.append({'kind': 'command_dispatch', 'requestRef': 'client:1', 'method': 'Runtime.evaluate', **actor})
    if cleanup is not None:
        events.append({'kind': 'cleanup_result', **actor, **cleanup})
    events.append({'kind': 'worker_stopped'})
    journal = directory / 'events.jsonl'
    journal.write_bytes(b''.join(json.dumps(event).encode() + b'\n' for event in events) + tail)
    journal.chmod(0o600)
    return directory


def inspect(runner, output, exclude=None):
    return runner['remote_workers_cleanup'](output, project_id='expected-project',
                                          exclude=exclude, deadline=time.monotonic())


def test_both_worker_roots_use_mode_specific_receipts_and_keep_effects_separate(tmp_path, runner):
    parent = worker(tmp_path, 'browsers', 'parent-run')
    (tmp_path / 'browsers/state-attempts').mkdir(mode=0o700)
    worker(tmp_path, 'browsers', 'regular-run', unknown=True,
           cleanup={'contextDisposed': True, 'connectionClosed': True})
    worker(tmp_path, 'actors', 'borrowed-run', mode='borrowed',
           cleanup={'contextDisposed': False, 'connectionClosed': True, 'attachmentDetached': True})
    worker(tmp_path, 'actors', 'profile-run', mode='provider-session',
           cleanup={'contextDisposed': False, 'connectionClosed': True, 'profileReleased': True})
    result = inspect(runner, tmp_path, parent)
    assert result['complete'] and result['workers'] == 3
    assert sum(run['unresolvedEffects'] for run in result['runs']) == 1


@pytest.mark.parametrize('change', ['wrong-project', 'torn', 'missing-cleanup', 'wrong-mode-fact', 'symlink'])
def test_invalid_owned_receipts_cannot_claim_cleanup(tmp_path, runner, change):
    directory = worker(tmp_path, 'actors', 'child-run',
        project='another-project' if change == 'wrong-project' else 'expected-project',
        mode='borrowed' if change == 'wrong-mode-fact' else 'fresh',
        cleanup=None if change == 'missing-cleanup' else {'contextDisposed': True, 'connectionClosed': True},
        tail=b'{"kind":' if change == 'torn' else b'')
    if change == 'symlink':
        (directory.parent / 'linked-run').symlink_to(directory, target_is_directory=True)
    assert inspect(runner, tmp_path)['complete'] is False


@pytest.mark.parametrize('closed', [True, False, None])
def test_native_runner_requires_provider_session_closure_as_well_as_context_disposal(tmp_path, runner, closed):
    directory = worker(tmp_path, 'actors', 'native-run',
                       cleanup={'contextDisposed': True, 'connectionClosed': True, 'remoteTermination': 'confirmed',
                                **({'providerSessionClosed': closed} if closed is not None else {})})
    journal = directory/'events.jsonl'
    events = [json.loads(line) for line in journal.read_text().splitlines()]
    events[1]['provider'] = 'browserserve'
    journal.write_text(''.join(json.dumps(event)+'\n' for event in events))
    assert inspect(runner, tmp_path)['complete'] is (closed is True)
