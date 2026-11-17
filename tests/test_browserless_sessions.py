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
            self.send_response(204)
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
