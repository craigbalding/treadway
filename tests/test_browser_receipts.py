"""Retained receipts survive missing replies and never authorize replay."""
import hashlib
import json

import pytest

from treadway.browser_receipts import BrowserEvidenceIncomplete, inspect_browser_run


def record(kind, **fields):
    return {'kind': kind, 'actor': 'member', 'generation': 'generation-one', **fields}


def journal(tmp_path, events, tail=b''):
    tmp_path.chmod(0o700)
    path = tmp_path/'events.jsonl'
    path.write_bytes(b''.join(json.dumps(value).encode()+b'\n' for value in [
        {'kind': 'worker_started', 'projectId': 'project-one', 'runId': 'run-one'}, *events])+tail)
    path.chmod(0o600)
    return path


def inspect(tmp_path):
    return inspect_browser_run(tmp_path, project_id='project-one', run_id='run-one')


def test_missing_reply_and_cleanup_do_not_turn_unknown_effect_into_rejection(tmp_path):
    journal(tmp_path, [record('acquisition_intent'), record('acquisition_ready'),
        record('command_dispatch', requestRef='client:1', method='Runtime.evaluate'),
        record('cleanup_result', contextDisposed=True, connectionClosed=True), {'kind': 'worker_stopped'}])
    result = inspect(tmp_path)
    assert result['journalComplete'] and result['workerStoppedObserved']
    assert result['resumePermitted'] is False
    actor, = result['actors']
    assert actor['cleanup']['contextDisposed'] is True
    assert actor['cleanup']['remoteTermination'] is False
    assert actor['unresolvedEffects'] == ['client:1']
    assert actor['commands'][0]['outcome'] == 'unknown'


def test_torn_tail_preserves_prior_dispatch_and_cannot_supply_a_reply(tmp_path):
    path = journal(tmp_path, [record('acquisition_intent'),
        record('command_dispatch', requestRef='client:1', method='Runtime.evaluate')],
        tail=b'{"kind":"command_replied","requestRef":"client:1"')
    before = path.read_bytes()
    result = inspect(tmp_path)
    assert result['journalComplete'] is False and result['issue'] == 'browser_run_torn_tail'
    assert result['actors'][0]['unresolvedEffects'] == ['client:1']
    assert path.read_bytes() == before


def test_reconciliation_requires_the_retained_private_evidence_to_still_match(tmp_path):
    directory = tmp_path/'reconciliations'
    directory.mkdir(mode=0o700)
    observation = directory/'observer-one'
    observation.write_bytes(b'{"writes":1}')
    observation.chmod(0o600)
    journal(tmp_path, [record('acquisition_intent'),
        record('command_dispatch', requestRef='client:1', method='Runtime.evaluate'),
        record('command_unknown', requestRef='client:1'), record('application_reconciled', requestRef='client:1',
            outcome='applied', evidence={'reference': 'observer-one', 'sha256': hashlib.sha256(observation.read_bytes()).hexdigest()})])
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == []
    assert inspect(tmp_path)['resumePermitted'] is False
    observation.write_bytes(b'{}')
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']
    observation.write_bytes(b'{"writes":1}')
    observation.chmod(0o644)
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']


def test_wrong_scope_and_public_journal_are_refused_without_creating_state(tmp_path):
    path = journal(tmp_path, [])
    with pytest.raises(BrowserEvidenceIncomplete, match='binding_differs'):
        inspect_browser_run(tmp_path, project_id='project-two', run_id='run-one')
    path.chmod(0o644)
    with pytest.raises(BrowserEvidenceIncomplete, match='private_bounded'):
        inspect(tmp_path)
    with pytest.raises(BrowserEvidenceIncomplete):
        inspect(tmp_path/'absent')
    assert not (tmp_path/'absent').exists()


def test_malformed_middle_record_cannot_hide_an_unresolved_prior_dispatch(tmp_path):
    journal(tmp_path, [record('acquisition_intent'), record('command_dispatch', requestRef='client:1', method='Runtime.evaluate'),
        record('command_replied', requestRef='missing:2'), record('command_replied', requestRef='client:1')])
    result = inspect(tmp_path)
    assert result['journalComplete'] is False
    assert result['actors'][0]['unresolvedEffects'] == ['client:1']
