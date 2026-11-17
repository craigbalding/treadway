"""Synthetic Session API lifecycle and identity exclusion; no browser/cloud."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading

import pytest

from treadway.browser_runtime import BrowserRuntime
from treadway.browser_state import BrowserIdentity, BrowserStateIncomplete
from treadway.browserless_sessions import ProviderSessionIncomplete, canonical_identity, read_capability
from treadway.cdp import CdpSocket, CommandSession


@pytest.fixture
def service(monkeypatch):
    seen, controls = [], {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append((self.command, self.path, body))
            if controls.get('lose_reply'):
                self.close_connection = True
                return
            if controls.get('partial_body'):
                self.send_response(201)
                self.send_header('Content-Length', '200')
                self.end_headers()
                self.wfile.write(b'{"id":"partial')
                self.close_connection = True
                return
            code = controls.get('status', 201)
            self.send_response(code)
            if controls.get('redirect'):
                self.send_header('Location', '/unexpected-discovery')
            self.end_headers()
            base = f'http://127.0.0.1:{self.server.server_port}'
            value = {'id': 'synthetic-session', 'ttl': body['ttl'],
                'connect': base.replace('http:', 'ws:') + '/connect/synthetic-session?token=synthetic-connect&x=%2B+',
                'stop': base + '/stop/synthetic-session?token=synthetic-stop&x=%2B+'}
            value.update(controls.get('response', {}))
            self.wfile.write(json.dumps(value).encode())

        def do_DELETE(self):
            seen.append((self.command, self.path, None))
            if controls.get('lose_delete_reply'):
                self.close_connection = True
                return
            self.send_response(controls.get('delete_status', 204))
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f'http://127.0.0.1:{server.server_port}/session?token=synthetic-create&x=%2B+'
    monkeypatch.setenv('TREADWAY_SESSION_API_FIXTURE', endpoint)
    try:
        yield seen, controls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def runtime(tmp_path, **changes):
    return BrowserRuntime(tmp_path/'run', project_root=tmp_path/'project', configuration={
        'provider': 'browserless', 'mode': 'provider-session', 'binding': 'session-service',
        'session_api_env': 'TREADWAY_SESSION_API_FIXTURE', **changes})


def identity(tmp_path, **changes):
    return BrowserIdentity(**{'root': tmp_path/'identities', 'resource': 'synthetic-member',
        'application': 'workboard', 'identity_ref': 'member', 'provider_binding': 'session-service',
        'origins': ('https://app.example.invalid',), **changes})


@pytest.fixture
def protocol_service(monkeypatch):
    root = Path(__file__).resolve().parents[1]
    child = subprocess.Popen(['node', str(root/'tests/remote-protocol-server.js'), 'Infinity', 'provider'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    value = json.loads(child.stdout.readline())
    monkeypatch.setenv('TREADWAY_SESSION_API_FIXTURE', value['sessionApi'])
    try:
        yield value
    finally:
        child.stdin.close()
        child.wait(timeout=5)
        assert child.returncode == 0, child.stderr.read().decode()


def command(browsers, member, method, params):
    with browsers.drive(member):
        socket = CdpSocket(connection=member.connection())
        try:
            return CommandSession(socket).command(method, params)
        finally:
            socket.close()


def test_configuration_construction_and_wrong_entry_point_are_passive(tmp_path):
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        with pytest.raises(ValueError, match='explicit_provider_identity'):
            browsers.acquire('member')
    for changes in [{'endpoint_env': 'OTHER'}, {'reconnect': {}},
                    {'session_allowed_origins': ['https://browser.example.invalid/path']}]:
        with pytest.raises(ValueError):
            runtime(tmp_path, **changes)
    assert not list(tmp_path.iterdir())
    assert 'synthetic-member' not in repr(state)


def test_create_retains_exact_returned_urls_and_forget_is_a_separate_explicit_operation(tmp_path, service, monkeypatch):
    seen, _ = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        result = browsers.create_provider_identity(state, ttl_seconds=180)
        assert result['created'] and 'token' not in json.dumps(result)
        assert seen == [('POST', '/session?token=synthetic-create&x=%2B+',
            {'ttl': 180000, 'processKeepAlive': 0, 'headless': True, 'browser': 'chromium'})]
        assert browsers.process is None
        with pytest.raises(BrowserStateIncomplete, match='already_exists'):
            browsers.create_provider_identity(state, ttl_seconds=180)
        assert len(seen) == 1
        lease = state.acquire(browsers.project_id)
        capability, path, _ = read_capability(lease)
        assert path.stat().st_mode & 0o077 == 0
        assert capability['session']['connect'].endswith('?token=synthetic-connect&x=%2B+')
        evidence = json.loads((lease.directory/capability['creation']['file']).read_text())
        assert json.loads(base64.b64decode(evidence['responseBodyBase64']))['id'] == 'synthetic-session'
        lease.release(profile_released=True, uncertain=False)
        monkeypatch.delenv('TREADWAY_SESSION_API_FIXTURE')
        assert browsers.forget_provider_identity(state)['profileDeleted'] is True
        assert seen[-1] == ('DELETE', '/stop/synthetic-session?token=synthetic-stop&x=%2B+', None)
        assert all(item.stat().st_mode & 0o077 == 0 for item in state.root.rglob('*'))


def test_actual_profile_lease_refuses_alias_and_project_writers_and_destructive_forget(tmp_path, service):
    seen, _ = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        lock = canonical_identity(state, 'synthetic-session').acquire(browsers.project_id)
        try:
            with pytest.raises(BrowserStateIncomplete, match='in_use'):
                canonical_identity(identity(tmp_path, resource='other', identity_ref='alias'), 'synthetic-session').acquire('project-two')
            with pytest.raises(BrowserStateIncomplete, match='in_use'):
                browsers.forget_provider_identity(state)
            assert len(seen) == 1
        finally:
            lock.release(profile_released=True, uncertain=False)
        browsers.forget_provider_identity(state)


def test_borrowing_a_profile_identity_fails_before_worker_start_and_keeps_the_profile_usable(tmp_path, service, monkeypatch):
    seen, _ = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
    monkeypatch.setenv('TREADWAY_ATTACHMENT_FIXTURE', json.dumps({'version': 1,
        'endpoint': 'ws://127.0.0.1:1/existing', 'contextId': 'synthetic-context',
        'targetId': 'synthetic-page', 'scope': 'context', 'permission': 'observe'}))
    with BrowserRuntime(tmp_path/'borrow', project_root=tmp_path/'project', configuration={
            'provider': 'browserless', 'mode': 'borrowed', 'binding': 'session-service',
            'attachment_env': 'TREADWAY_ATTACHMENT_FIXTURE'}) as browsers:
        with pytest.raises(BrowserStateIncomplete, match='storage_kind_differs'):
            browsers.borrow('member', state)
        assert browsers.process is None
    with runtime(tmp_path) as browsers:
        assert browsers.forget_provider_identity(state)['profileDeleted'] is True
    assert [event[0] for event in seen] == ['POST', 'DELETE']


def test_lost_creation_reply_blocks_repeat_creation_and_retains_first_attempt(tmp_path, service):
    seen, controls = service
    controls['lose_reply'] = True
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        with pytest.raises(ProviderSessionIncomplete, match='http_incomplete'):
            browsers.create_provider_identity(state, ttl_seconds=180)
        with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
            browsers.create_provider_identity(state, ttl_seconds=180)
        assert len(seen) == 1
        facts = list(state.root.glob('*/provider-http-*.json'))
        assert len(facts) == 1 and json.loads(facts[0].read_text())['outcome'] == 'unknown'


def test_redirect_or_untrusted_returned_authority_never_causes_a_followup_request(tmp_path, service):
    seen, controls = service
    with runtime(tmp_path) as browsers:
        controls.update(status=302, redirect=True)
        with pytest.raises(ProviderSessionIncomplete, match='creation_incomplete'):
            browsers.create_provider_identity(identity(tmp_path), ttl_seconds=180)
        controls.clear()
        controls['response'] = {'stop': 'https://other.example.invalid/stop?token=must-stay-private'}
        with pytest.raises(ProviderSessionIncomplete, match='contract_incomplete'):
            browsers.create_provider_identity(identity(tmp_path, resource='another-member'), ttl_seconds=180)
        assert [event[0] for event in seen] == ['POST', 'POST']


def test_truncated_creation_body_is_unknown_and_partial_bytes_are_retained(tmp_path, service):
    seen, controls = service
    controls['partial_body'] = True
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        with pytest.raises(ProviderSessionIncomplete, match='response_body_incomplete'):
            browsers.create_provider_identity(state, ttl_seconds=180)
        facts, = state.root.glob('*/provider-http-*.json')
        value = json.loads(facts.read_text())
        assert value['status'] == 201 and value['complete'] is False
        assert base64.b64decode(value['responseBodyBase64']) == b'{"id":"partial'
        with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
            browsers.create_provider_identity(state, ttl_seconds=180)
        assert len(seen) == 1


def test_known_creation_refusal_can_be_corrected_explicitly_without_stealing_an_owner(tmp_path, service):
    seen, controls = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        controls['status'] = 429
        with pytest.raises(ProviderSessionIncomplete) as result:
            browsers.create_provider_identity(state, ttl_seconds=180)
        assert result.value.outcome == 'rejected' and result.value.status == 429
        assert len(seen) == 1
        controls.clear()
        assert browsers.create_provider_identity(state, ttl_seconds=180)['created'] is True
        with pytest.raises(BrowserStateIncomplete, match='storage_kind_differs'):
            state.forget(browsers.project_id)
        assert len(seen) == 2
        browsers.forget_provider_identity(state)


def test_profile_survives_clean_release_and_next_generation_verifies_before_return(tmp_path, protocol_service):
    from treadway.browser_receipts import inspect_browser_run
    state = identity(tmp_path)
    principal = {'origin': state.origins[0], 'probe': '/principal', 'expected': {'principal': 'member'}}
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        with pytest.raises(BrowserStateIncomplete, match='initial_setup_required'):
            browsers.acquire_provider_identity('member', state, principal=principal)
        member = browsers.acquire_provider_identity('member', state, principal=principal, initial_setup=True)
        command(browsers, member, 'Runtime.evaluate', {'expression': 'save:retained-profile'})
        command(browsers, member, 'Storage.setCookies', {'cookies': [{'name': 'session', 'value': 'synthetic-member'}]})
        assert browsers.verify_provider_identity(member)['verified'] is True
        first_generation = member.generation
        cleanup = browsers.release(member)
        assert cleanup['profileReleased'] is True and cleanup['contextDisposed'] is False
        assert cleanup['identity']['recoveryRequired'] is False
        facts = inspect_browser_run(browsers.evidence, project_id=browsers.project_id, run_id=browsers.run_id)
        assert facts['journalComplete'] is True
        assert facts['actors'][0]['mode'] == 'provider-session'
        assert facts['actors'][0]['cleanup']['profileReleased'] is True
    with runtime(tmp_path) as browsers:
        member = browsers.acquire_provider_identity('member', state, principal=principal)
        assert member.generation != first_generation
        assert command(browsers, member, 'Runtime.evaluate', {'expression': 'read'})['result']['value'] == 'retained-profile'
        assert command(browsers, member, 'Storage.getCookies', {})['cookies'] == [{'name': 'session', 'value': 'synthetic-member'}]
        with pytest.raises(BrowserStateIncomplete, match='in_use'):
            browsers.forget_provider_identity(state)
        with pytest.raises(BrowserStateIncomplete, match='in_use'):
            with runtime(tmp_path/'another') as other:
                other.acquire_provider_identity('alias', state, principal=principal)
        browsers.release(member)
        assert browsers.forget_provider_identity(state)['profileDeleted'] is True
        browsers.create_provider_identity(state, ttl_seconds=180)
        with pytest.raises(BrowserStateIncomplete, match='initial_setup_required'):
            browsers.acquire_provider_identity('replacement', state, principal=principal)
        assert browsers.forget_provider_identity(state)['profileDeleted'] is True


def test_changed_principal_binding_refuses_before_starting_a_new_browser(tmp_path, protocol_service):
    state = identity(tmp_path)
    principal = {'origin': state.origins[0], 'probe': '/principal', 'expected': {'principal': 'member'}}
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        member = browsers.acquire_provider_identity('member', state, principal=principal, initial_setup=True)
        browsers.verify_provider_identity(member)
        browsers.release(member)
    with runtime(tmp_path) as browsers:
        with pytest.raises(BrowserStateIncomplete, match='principal_binding_differs'):
            browsers.acquire_provider_identity('member', state, principal={**principal, 'expected': {'principal': 'another-member'}})
        assert browsers.process is None
        browsers.forget_provider_identity(state)


def abandoned_profile(tmp_path, browsers, state, *, unknown=False):
    directory = tmp_path/'previous-run'
    directory.mkdir(mode=0o700)
    previous = {'run_id': 'previous-run', 'actor': 'member', 'generation': 'previous-generation'}
    leases = [state.acquire(browsers.project_id), canonical_identity(state, 'synthetic-session').acquire(browsers.project_id)]
    for lease in leases:
        lease.record_run(directory=directory, project_id=browsers.project_id, run_id=previous['run_id'],
                         actor=previous['actor'], mode='provider-session')
        lease.record_generation(previous['generation'])
        lease.release(uncertain=True)
    actor = {'actor': previous['actor'], 'generation': previous['generation']}
    events = [{'kind': 'worker_started', 'projectId': browsers.project_id, 'runId': previous['run_id']},
        {'kind': 'acquisition_intent', 'mode': 'provider-session', **actor}, {'kind': 'acquisition_ready', **actor}]
    if unknown:
        events.append({'kind': 'command_dispatch', 'requestRef': 'client:1', 'method': 'Runtime.evaluate', **actor})
    events.append({'kind': 'worker_stopped'})
    path = directory/'events.jsonl'
    path.write_text(''.join(json.dumps(value)+'\n' for value in events))
    path.chmod(0o600)
    return previous, directory


def test_forced_profile_deletion_requires_exact_abandoned_run_and_nonstealing_locks(tmp_path, service):
    seen, _ = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        owner = state.acquire(browsers.project_id)
        try:
            with pytest.raises(BrowserStateIncomplete, match='in_use'):
                browsers.forget_provider_identity(state, force=True,
                    previous_run={'run_id': 'previous-run', 'actor': 'member', 'generation': 'previous-generation'})
        finally:
            owner.release(profile_released=True, uncertain=False)
        previous, _ = abandoned_profile(tmp_path, browsers, state)
        with pytest.raises(BrowserStateIncomplete, match='previous_run_differs'):
            browsers.forget_provider_identity(state, force=True, previous_run={**previous, 'generation': 'another-generation'})
        assert len(seen) == 1
        result = browsers.forget_provider_identity(state, force=True, previous_run=previous)
        assert result['profileDeleted'] is True and result['recoveryRequired'] is False
        assert seen[-1][1] == '/stop/synthetic-session?token=synthetic-stop&x=%2B+&force=true'
        assert browsers.process is None
        browsers.create_provider_identity(state, ttl_seconds=180)
        browsers.forget_provider_identity(state)


def test_deleted_profile_stays_blocked_until_independent_effect_reconciliation(tmp_path, service):
    from treadway.browser_receipts import inspect_browser_run, record_browser_reconciliation
    seen, _ = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        previous, directory = abandoned_profile(tmp_path, browsers, state, unknown=True)
        result = browsers.forget_provider_identity(state, force=True, previous_run=previous)
        assert result['profileDeleted'] is True and result['recoveryRequired'] is True
        with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
            browsers.create_provider_identity(state, ttl_seconds=180)
        with pytest.raises(BrowserStateIncomplete, match='effect_reconciliation_required'):
            browsers.recover_provider_identity(state, previous_run=previous)
        with pytest.raises(BrowserStateIncomplete, match='already_fenced_use_recovery'):
            browsers.forget_provider_identity(state, force=True, previous_run=previous)
        assert [item[0] for item in seen] == ['POST', 'DELETE']
        observed = inspect_browser_run(directory, project_id=browsers.project_id, run_id=previous['run_id'])
        source = tmp_path/'application-observer.json'
        source.write_text('{"resource":"synthetic-item","effect":"applied"}')
        source.chmod(0o600)
        record_browser_reconciliation(directory, project_id=browsers.project_id, run_id=previous['run_id'],
            actor=previous['actor'], generation=previous['generation'], request_ref='client:1',
            journal_sha256=observed['journalSha256'], outcome='applied', evidence=source)
        assert browsers.recover_provider_identity(state, previous_run=previous) == {
            'recovered': True, 'profileDeleted': True, 'previousGenerationResumed': False}
        assert len(seen) == 2 and browsers.process is None
        browsers.create_provider_identity(state, ttl_seconds=180)
        browsers.forget_provider_identity(state)


@pytest.mark.parametrize('lost_reply', [True, False])
def test_missing_or_changed_profile_deletion_proof_cannot_authorize_recovery(tmp_path, service, lost_reply):
    _, controls = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        previous, _ = abandoned_profile(tmp_path, browsers, state, unknown=True)
        controls['lose_delete_reply'] = lost_reply
        if lost_reply:
            with pytest.raises(ProviderSessionIncomplete):
                browsers.forget_provider_identity(state, force=True, previous_run=previous)
        else:
            browsers.forget_provider_identity(state, force=True, previous_run=previous)
            proof, = state.root.rglob('provider-fence-*.json')
            proof.write_text('{}')
        with pytest.raises(BrowserStateIncomplete, match='remote_fence_required'):
            browsers.recover_provider_identity(state, previous_run=previous)
        with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
            state.acquire(browsers.project_id)


def test_asynchronous_deletion_acceptance_is_not_a_remote_fence(tmp_path, service):
    _, controls = service
    state = identity(tmp_path)
    with runtime(tmp_path) as browsers:
        browsers.create_provider_identity(state, ttl_seconds=180)
        previous, _ = abandoned_profile(tmp_path, browsers, state)
        controls['delete_status'] = 202
        with pytest.raises(ProviderSessionIncomplete, match='forget_incomplete'):
            browsers.forget_provider_identity(state, force=True, previous_run=previous)
        with pytest.raises(BrowserStateIncomplete, match='remote_fence_required'):
            browsers.recover_provider_identity(state, previous_run=previous)
