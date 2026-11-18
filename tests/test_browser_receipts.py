"""Retained receipts survive missing replies and never authorize replay."""
import hashlib
import json

import pytest

from treadway.browser_receipts import BrowserEvidenceIncomplete, inspect_browser_run, record_browser_reconciliation


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


def test_borrowed_attachment_cleanup_is_distinct_from_context_disposal(tmp_path):
    journal(tmp_path, [record('acquisition_intent', mode='borrowed'), record('acquisition_ready'),
        record('cleanup_result', contextDisposed=False, connectionClosed=True, attachmentDetached=True)])
    actor, = inspect(tmp_path)['actors']
    assert actor['mode'] == 'borrowed'
    assert actor['cleanup'] == {'contextDisposed': False, 'connectionClosed': True,
                               'attachmentDetached': True, 'remoteTermination': False}


def test_unknown_acquisition_mode_cannot_be_read_as_fresh(tmp_path):
    journal(tmp_path, [record('acquisition_intent', mode='unsupported')])
    result = inspect(tmp_path)
    assert result['journalComplete'] is False
    assert result['actors'] == []


def reconcile(tmp_path, evidence, **changes):
    return record_browser_reconciliation(tmp_path, **{'project_id': 'project-one', 'run_id': 'run-one',
        'actor': 'member', 'generation': 'generation-one', 'request_ref': 'client:1',
        'journal_sha256': inspect(tmp_path)['journalSha256'], 'outcome': 'applied', 'evidence': evidence, **changes})


def pending(tmp_path, *, tail=b''):
    path = journal(tmp_path, [record('acquisition_intent'),
        record('command_dispatch', requestRef='client:1', method='Runtime.evaluate'),
        record('cleanup_result', contextDisposed=True, connectionClosed=True), {'kind': 'worker_stopped'}], tail=tail)
    evidence = tmp_path/'application-observation.json'
    evidence.write_bytes(b'{"resource":"synthetic-item","revision":2}')
    evidence.chmod(0o600)
    return path, evidence


def test_offline_application_observation_resolves_only_the_bound_unknown_and_never_resumes(tmp_path):
    path, evidence = pending(tmp_path)
    original = path.read_bytes()
    saved = reconcile(tmp_path, evidence)
    assert saved['recorded'] and saved['resumePermitted'] is False
    evidence.unlink()  # The observer's source is copied into the retained run.
    result = inspect(tmp_path)
    assert result['offlineEvidenceComplete'] and result['resumePermitted'] is False
    assert result['actors'][0]['unresolvedEffects'] == []
    command, = result['actors'][0]['commands']
    assert command['outcome'] == 'unknown' and command['replyObserved'] is False
    assert command['offlineReconciliations'][0]['outcome'] == 'applied'
    assert path.read_bytes() == original
    retained = tmp_path/'reconciliations'/saved['evidence']['reference']
    retained.write_bytes(b'{}')
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']


def test_offline_observation_preserves_a_torn_journal_and_becomes_stale_after_an_append(tmp_path):
    path, evidence = pending(tmp_path, tail=b'{"kind":')
    original = path.read_bytes()
    reconcile(tmp_path, evidence)
    observed = inspect(tmp_path)
    assert observed['actors'][0]['unresolvedEffects'] == []
    assert observed['journalComplete'] is False
    assert path.read_bytes() == original
    path.write_bytes(original + b'"unobserved"}')
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']


def test_wrong_offline_bindings_and_replied_commands_are_refused_without_sidecars(tmp_path):
    path, evidence = pending(tmp_path)
    for changes in [{'journal_sha256': '0'*64}, {'actor': 'other'}, {'generation': 'other'}, {'request_ref': 'client:2'}]:
        with pytest.raises(BrowserEvidenceIncomplete):
            reconcile(tmp_path, evidence, **changes)
    path.write_bytes(path.read_bytes()+json.dumps(record('command_replied', requestRef='client:1')).encode()+b'\n')
    with pytest.raises(BrowserEvidenceIncomplete, match='unknown_dispatch_required'):
        reconcile(tmp_path, evidence)
    assert not (tmp_path/'offline-reconciliations').exists()


def test_conflicting_or_invalid_offline_evidence_keeps_the_effect_unknown(tmp_path):
    _, evidence = pending(tmp_path)
    reconcile(tmp_path, evidence, outcome='unknown')
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']
    reconcile(tmp_path, evidence, outcome='applied')
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == []
    reconcile(tmp_path, evidence, outcome='not_applied')
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']
    (tmp_path/'offline-reconciliations'/'unexpected.json').write_text('{}')
    assert inspect(tmp_path)['offlineEvidenceComplete'] is False
    assert inspect(tmp_path)['actors'][0]['unresolvedEffects'] == ['client:1']


@pytest.mark.parametrize('closed', [True, False, 'true'])
def test_native_provider_cleanup_retains_and_type_checks_session_closure(tmp_path, closed):
    journal(tmp_path, [record('acquisition_intent', provider='browserserve'),
        record('cleanup_result', contextDisposed=True, connectionClosed=True,
               providerSessionClosed=closed, providerCloseCode=1006), {'kind': 'worker_stopped'}])
    observed = inspect(tmp_path)
    assert observed['actors'][0]['provider'] == 'browserserve'
    if type(closed) is bool:
        assert observed['journalComplete']
        assert observed['actors'][0]['cleanup']['providerSessionClosed'] is closed
        assert observed['actors'][0]['cleanup']['providerCloseCode'] == 1006
    else:
        assert not observed['journalComplete']
