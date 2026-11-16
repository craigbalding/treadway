"""Real local HTTP effects, synthetic credential owners; no external applications."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
from threading import Thread
import time

import pytest

from treadway.recovery import (Assessment, AuthenticationOwner, AuthenticationResult,
                               OperationExecutor, OperationIncomplete, RecoveryError, RecoveryPolicy)
from treadway.sessions import HttpFailure, HttpSession


@pytest.fixture
def application():
    state = {'token': 'initial', 'effects': {}, 'calls': [], 'refreshes': 0,
             'expire_at': 37, 'lost': set(), 'keys': {}, 'csrf': False, 'csrf_number': 0,
             'probe_mode': None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body, headers=()):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(data)))
            for key, value in headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            state['calls'].append(('GET', self.path))
            if self.path.startswith('/effects/'):
                return self.reply(200, state['effects'].get(self.path.split('/')[-1]))
            if self.path == '/principal':
                if state.get('cookie_auth') and self.headers.get('Cookie'):
                    return self.reply(200, {'principal': 'member' if self.headers.get('Cookie') == 'session=member' else 'another-user'})
                mode = state['probe_mode']
                if mode == 'wrong':
                    return self.reply(200, {'principal': 'another-user'})
                if mode == 'malformed':
                    return self.reply(200, {'unexpected': True})
                if mode == 'forbidden':
                    return self.reply(403, {'error': 'permission_denied'})
                if self.headers.get('Authorization') != state['token']:
                    return self.reply(401, {'error': 'session_expired'})
                headers = []
                if state['csrf']:
                    state['csrf_number'] += 1
                    headers = [('X-CSRF-Token', str(state['csrf_number'])),
                               ('Set-Cookie', f"csrf={state['csrf_number']}; Path=/; HttpOnly")]
                return self.reply(200, {'principal': 'member'}, headers)
            self.reply(404, {})

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            state['calls'].append(('POST', self.path))
            if self.path == '/refresh':
                state['refreshes'] += 1
                return self.reply(200, {'token': state['token']})
            if (self.headers.get('Authorization') != state['token'] and
                    not (state.get('cookie_auth') and self.headers.get('Cookie') == 'session=member')):
                return self.reply(401, {'error': 'session_expired'})
            if state['csrf'] and (self.headers.get('X-CSRF-Token') != str(state['csrf_number'])
                                  or self.headers.get('Cookie') != f"csrf={state['csrf_number']}"):
                return self.reply(403, {'error': 'csrf_differs'})
            key = self.headers.get('Idempotency-Key')
            if key in state['keys']:
                assert state['keys'][key] == payload
            else:
                assert payload['id'] not in state['effects'], 'duplicate business effect'
                state['effects'][payload['id']] = payload
                if key:
                    state['keys'][key] = payload
            if len(state['effects']) == state['expire_at']:
                state['token'] = 'renewed'
            if payload['id'] in state['lost']:
                state['lost'].remove(payload['id'])
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.reply(201, {'id': payload['id']})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}', state
    server.shutdown()
    server.server_close()
    thread.join()


def configured(tmp_path, application, **overrides):
    origin, state = application
    credentials = {'Authorization': 'initial'}
    session = HttpSession(actor='member', origin=origin, credential_headers=lambda: dict(credentials))

    def renew(client, context):
        assert not context.allow_interactive
        response = client.request('/refresh', method='POST', body={'grant': 'synthetic'})
        credentials['Authorization'] = response.json()['token']
        return AuthenticationResult('ready', 'application_refresh')

    owner = AuthenticationOwner('synthetic-client/member/grant', tmp_path / 'owners',
        prepare=lambda client, context: AuthenticationResult('ready', 'sdk_cache'), renew=renew,
        classify=lambda error: isinstance(error, HttpFailure) and error.observation is not None
        and error.observation.status == 401 and error.observation.complete
        and error.observation.json() == {'error': 'session_expired'})

    def assess(operation, observation, client):
        if isinstance(observation, HttpFailure):
            return Assessment('unknown')
        if observation.complete and observation.status == 401 and observation.json() == {'error': 'session_expired'}:
            return Assessment('rejected', authentication_required=True, replay='not_applied',
                              evidence={'contract': 'synthetic-before-effect-authentication'})
        actual = client.request('/effects/' + operation['body']['id']).json()
        return Assessment('confirmed' if actual == operation['body'] else 'unknown', evidence=actual)

    def reconcile(operation, previous, client):
        actual = client.request('/effects/' + operation['body']['id']).json()
        return Assessment('confirmed' if actual == operation['body'] else 'unknown', evidence=actual)

    options = dict(probe='/principal', expected={'principal': 'member'}, owner=owner,
                   assess=assess, reconcile=reconcile,
                   policy=RecoveryPolicy(maintain_authentication=True))
    options.update(overrides)
    return OperationExecutor(session, tmp_path / 'operations', **options), state, credentials


def execute(executor, index=1, **kwargs):
    return executor.execute(f'mutation-{index}', '/mutations',
                            body={'id': f'mutation-{index}', 'value': index}, binding={'row': index}, **kwargs)


def test_100_distinct_bindings_continue_after_expiry_with_one_effect_each(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    receipts = [execute(executor, index) for index in range(1, 101)]
    assert all(r['state'] == 'confirmed' and r['dispatches'] == 1 for r in receipts)
    assert len(state['effects']) == 100 and state['refreshes'] == 1
    assert sum(r['renewals'] for r in receipts) == 1
    # Repeating a completed binding reads the durable result without new traffic.
    before = list(state['calls'])
    assert execute(executor, 38)['state'] == 'confirmed'
    assert state['calls'] == before


@pytest.mark.parametrize('mode', ['wrong', 'malformed', 'forbidden'])
def test_probe_failures_keep_evidence_and_never_trigger_generic_renewal(tmp_path, application, mode):
    executor, state, _ = configured(tmp_path, application)
    state['probe_mode'] = mode
    with pytest.raises(OperationIncomplete) as failure:
        execute(executor)
    receipt = failure.value.receipt
    assert receipt['dispatches'] == 0 and receipt['state'] == 'not_dispatched'
    observation = next(e['value'] for e in executor.read_evidence('mutation-1')['history'] if e['kind'] == 'observation')
    assert observation['phase'] == 'probe' and observation['http']['body_base64']
    assert state['refreshes'] == 0 and not state['effects']


def test_committed_mutation_with_lost_response_reconciles_without_replay(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['lost'].add('mutation-1')
    receipt = execute(executor)
    assert receipt['state'] == 'confirmed' and receipt['dispatches'] == 1
    observation = next(e['value'] for e in executor.read_evidence('mutation-1')['history'] if e['kind'] == 'observation')
    assert observation['dispatch'] == 'possibly_started'
    assert len(state['effects']) == 1


def test_unknown_effect_stops_and_stays_unknown_on_restart(tmp_path, application):
    executor, state, _ = configured(tmp_path, application, reconcile=None)
    state['lost'].add('mutation-1')
    for _ in range(2):
        with pytest.raises(OperationIncomplete) as failure:
            execute(executor)
        assert failure.value.receipt['state'] == 'unknown'
    assert len(state['effects']) == 1
    assert state['calls'].count(('POST', '/mutations')) == 1


def test_crash_after_commit_before_recording_completion_requires_reconciliation(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    def crash(*args):
        raise SystemExit('simulated process interruption')
    executor.assess = crash
    with pytest.raises(SystemExit):
        execute(executor)
    restarted, _, _ = configured(tmp_path, application)
    assert execute(restarted)['state'] == 'confirmed'
    assert state['calls'].count(('POST', '/mutations')) == 1


def test_successful_resume_reports_current_completion_and_retains_first_failure(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['probe_mode'] = 'wrong'
    with pytest.raises(OperationIncomplete):
        execute(executor)
    state['probe_mode'] = None
    receipt = execute(executor)
    assert receipt['state'] == receipt['code'] == 'confirmed'
    assert any(event['kind'] == 'stopped' for event in executor.read_evidence('mutation-1')['history'])
    assert execute(executor)['code'] == 'confirmed'


@pytest.mark.parametrize('handoff', ['valid', 'wrong_user', 'incomplete'])
def test_browser_export_needs_complete_import_and_actual_http_principal(tmp_path, application, handoff):
    executor, state, _ = configured(tmp_path, application)
    state['token'] = 'renewed'
    state['cookie_auth'] = True
    exports = []
    def browser_renew(client, context):
        exports.append('browser_reported_success')
        # A browser's success is evidence for its own transport. The HTTP client
        # must import a complete binding and then prove its actual principal.
        snapshot = {'version': 'treadway.cookies/1', 'complete': handoff != 'incomplete',
                    'actor': 'member', 'generation': 'synthetic-browser', 'origin': client.origin,
                    'cookies': [{'name': 'session', 'value': 'member' if handoff == 'valid' else 'other',
                                 'domain': '127.0.0.1', 'path': '/', 'secure': False, 'httpOnly': True,
                                 'session': True, 'expires': -1, 'sameSite': 'Lax'}]}
        client.import_browser_cookies(snapshot, generation='synthetic-browser')
        return AuthenticationResult('ready', 'browser_sso')
    executor.owner.renew = browser_renew
    if handoff == 'valid':
        assert execute(executor)['state'] == 'confirmed'
        assert len(state['effects']) == 1
    else:
        with pytest.raises(OperationIncomplete) as failure:
            execute(executor)
        assert failure.value.receipt['dispatches'] == 0 and not state['effects']
        if handoff == 'wrong_user':
            assert failure.value.receipt['code'] == 'actual_principal_differs'
        else:
            assert not list(executor.session._jar)
    assert exports == ['browser_reported_success']


def test_exact_binding_payload_and_semantic_headers_are_pinned(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    execute(executor, headers={'If-Match': 'revision-1'})
    for kwargs in ({'headers': {'If-Match': 'revision-2'}}, {'headers': {}}):
        with pytest.raises(RecoveryError, match='intent_differs'):
            execute(executor, **kwargs)
    assert len(state['effects']) == 1


def test_uncertain_rotating_refresh_blocks_another_operation_and_old_token_replay(tmp_path, application):
    executor, state, credentials = configured(tmp_path, application)
    state['token'] = 'renewed'
    calls = []
    def lost_refresh(client, context):
        calls.append(True)  # server consumed refresh credential; replacement was lost
        raise TimeoutError('private rotating token must never leak')
    executor.owner.renew = lost_refresh
    for index in (1, 2):
        with pytest.raises(OperationIncomplete) as failure:
            execute(executor, index)
        assert failure.value.receipt['dispatches'] == 0
        assert 'private rotating token' not in str(failure.value)
    assert calls == [True] and not state['effects']
    assert credentials['Authorization'] == 'initial'


def test_shared_owner_gate_prevents_two_consumers_rotating_the_same_grant(tmp_path, application):
    first, _, _ = configured(tmp_path, application)
    second, _, _ = configured(tmp_path, application)
    with first.owner.lease():
        with pytest.raises(RecoveryError, match='scope_in_use'):
            execute(second)


def test_disabled_maintenance_keeps_verification_and_expiry_mode_can_suppress_it(tmp_path, application):
    executor, state, _ = configured(tmp_path, application, policy=RecoveryPolicy())
    state['token'] = 'renewed'
    with pytest.raises(OperationIncomplete):
        execute(executor)
    assert state['calls'] == [('GET', '/principal')]
    assert not state['effects'] and state['refreshes'] == 0
    executor, _, _ = configured(tmp_path / 'expiry-test', application,
        policy=RecoveryPolicy(verify_principal=False),
        assess=lambda op, result, session: Assessment('rejected', evidence={'status': result.status}))
    assert execute(executor)['state'] == 'rejected'
    assert state['calls'][-1] == ('POST', '/mutations')
    assert state['calls'].count(('GET', '/principal')) == 1 and state['refreshes'] == 0


def test_probe_cookie_and_csrf_rotation_materialize_before_mutation(tmp_path, application):
    executor, state, credentials = configured(tmp_path, application)
    state['csrf'] = True
    credentials['X-CSRF-Token'] = 'old'
    executor.owner.volatile_headers = ('x-csrf-token',)
    executor.owner.after_probe_headers = lambda observed: {'X-CSRF-Token': observed.header('X-CSRF-Token')}
    assert execute(executor)['state'] == 'confirmed'
    assert len(state['effects']) == 1


def test_prerequisite_copy_cannot_repair_input_and_reentrant_client_fails_before_dispatch(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    def mutate_copy(operation):
        operation['body']['value'] = 'changed'
    executor.prerequisite = mutate_copy
    execute(executor)
    assert state['effects']['mutation-1']['value'] == 1
    executor.prerequisite = lambda operation: executor.session.request('/principal')
    with pytest.raises(OperationIncomplete) as failure:
        execute(executor, 2)
    assert failure.value.receipt['dispatches'] == 0
    assert len(state['effects']) == 1


def test_renewal_and_dispatch_budgets_survive_reentry(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['token'] = 'renewed'
    executor.owner.renew = lambda client, context: AuthenticationResult('ready', 'ineffective-refresh')
    for _ in range(2):
        with pytest.raises(OperationIncomplete) as failure:
            execute(executor)
        assert failure.value.receipt['renewals'] == 1
    assert not state['effects']


def test_return_after_owner_deadline_stops_before_probe_or_action(tmp_path, application):
    executor, state, _ = configured(tmp_path, application,
        policy=RecoveryPolicy(maintain_authentication=True, owner_timeout_seconds=.001))
    def slow(client, context):
        time.sleep(.01)
        return AuthenticationResult('ready')
    executor.owner.prepare = slow
    with pytest.raises(OperationIncomplete):
        execute(executor)
    assert not state['calls']


def test_idempotency_permission_reuses_exact_key_and_body_after_unknown_effect(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['lost'].add('mutation-1')
    executor.reconcile = lambda op, record, session: Assessment('unknown', replay='idempotency_valid',
        evidence={'contract': 'synthetic-durable-key-within-retention', 'key': op['idempotency_key']},
        replay_until=time.time()+60)
    receipt = execute(executor, idempotency_key='stable-key-1', headers={'If-Match': 'revision-1'})
    assert receipt['state'] == 'confirmed' and receipt['dispatches'] == 2
    assert state['keys']['stable-key-1'] == {'id': 'mutation-1', 'value': 1}
    assert len(state['effects']) == 1


def test_expiry_between_probe_and_mutation_uses_explicit_no_effect_contract(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    once = []
    def expire_after_probe(operation):
        if not once:
            once.append(True)
            state['token'] = 'renewed'
    executor.prerequisite = expire_after_probe
    receipt = execute(executor)
    assert receipt['state'] == 'confirmed' and receipt['dispatches'] == 2
    assert receipt['renewals'] == 1 and len(state['effects']) == 1


def test_import_and_construction_are_passive(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    assert not state['calls']
    assert not (tmp_path / 'owners').exists() and not (tmp_path / 'operations').exists()


def test_prior_unknown_survives_failed_retry_probe_and_expired_idempotency_permission(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['lost'].add('mutation-1')
    reconciliations = []
    def reconcile(op, record, client):
        reconciliations.append(True)
        if len(reconciliations) == 1:
            state['probe_mode'] = 'wrong'
            return Assessment('unknown', replay='idempotency_valid', replay_until=time.time()+60)
        return Assessment('unknown', evidence={'reason': 'key_retention_expired'})
    executor.reconcile = reconcile
    with pytest.raises(OperationIncomplete) as failure:
        execute(executor, idempotency_key='stable-1')
    assert failure.value.receipt['state'] == 'unknown'
    assert failure.value.receipt['unresolved_effect'] is True
    state['probe_mode'] = None
    with pytest.raises(OperationIncomplete):
        execute(executor, idempotency_key='stable-1')
    assert len(reconciliations) == 2
    assert state['calls'].count(('POST', '/mutations')) == 1


def test_safe_receipt_does_not_return_private_response_headers_or_bodies(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['csrf'] = True
    executor.owner.volatile_headers = ('x-csrf-token',)
    executor.owner.after_probe_headers = lambda observed: {'X-CSRF-Token': observed.header('X-CSRF-Token')}
    receipt = execute(executor)
    assert not {'intent', 'history', 'headers', 'body_base64'} & receipt.keys()
    assert 'Set-Cookie' not in repr(receipt)
    assert executor.read_evidence('mutation-1')['intent']['body']['value'] == 1


def test_authentication_can_renew_for_read_only_reconciliation_without_replay_permission(tmp_path, application):
    executor, state, credentials = configured(tmp_path, application)
    state['lost'].add('mutation-1')
    def assess(op, observed, client):
        state['token'] = 'renewed'
        return Assessment('unknown', authentication_required=True)
    def reconcile(op, previous, client):
        assert credentials['Authorization'] == state['token']
        assert client.request('/effects/mutation-1').json() == op['body']
        return Assessment('confirmed')
    executor.assess, executor.reconcile = assess, reconcile
    receipt = execute(executor)
    assert receipt['state'] == 'confirmed' and receipt['renewals'] == 1
    assert state['calls'].count(('POST', '/mutations')) == 1


def test_rejected_replay_cannot_clear_earlier_unknown_effect_or_skip_retention_recheck(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['lost'].add('mutation-1')
    reconciliations = []
    def reconcile(op, previous, client):
        reconciliations.append(True)
        if len(reconciliations) == 1:
            return Assessment('unknown', replay='idempotency_valid', replay_until=time.time()+60)
        return Assessment('unknown', evidence={'reason': 'key_retention_expired'})
    attempts = []
    def expire_before_second_dispatch(op):
        attempts.append(True)
        if len(attempts) == 2:
            state['token'] = 'renewed'
    executor.reconcile, executor.prerequisite = reconcile, expire_before_second_dispatch
    with pytest.raises(OperationIncomplete) as failure:
        execute(executor, idempotency_key='stable-1')
    assert failure.value.receipt['state'] == 'unknown'
    assert failure.value.receipt['unresolved_effect'] is True
    assert state['calls'].count(('POST', '/mutations')) == 2  # first uncertain, second explicitly rejected
    assert len(state['effects']) == 1 and len(reconciliations) == 2


def test_owner_reconciliation_receives_original_uncertain_invocation_and_archives_it(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['token'] = 'renewed'
    original_renew = executor.owner.renew
    def lost_refresh(client, context):
        raise TimeoutError('private-token-not-for-output')
    executor.owner.renew = lost_refresh
    with pytest.raises(OperationIncomplete):
        execute(executor)
    seen = []
    def resolve_previous(client, context):
        previous = context.previous
        seen.append(previous)
        assert previous['operation_id'] == 'mutation-1'
        assert previous['reason'] == 'authentication_required'
        assert previous['state'] == 'unknown'
        return AuthenticationResult('ready', 'sdk_reconciled_its_cache')
    executor.owner.reconcile = resolve_previous
    executor.owner.renew = original_renew
    assert execute(executor, 2)['state'] == 'confirmed'
    assert len(seen) == 1
    archived = executor.owner.store.read(executor.owner.key + ':' + seen[0]['attempt_id'])
    assert archived['error_type'] == 'TimeoutError' and archived['state'] == 'unknown'
    assert 'private-token' not in json.dumps(archived)


def test_owner_lease_is_shared_across_processes(tmp_path, application):
    import subprocess
    import sys
    executor, _, _ = configured(tmp_path, application)
    script = ('from treadway.recovery import AuthenticationOwner,AuthenticationResult,RecoveryError\n'
              'import sys\n'
              'owner=AuthenticationOwner(sys.argv[1],sys.argv[2],prepare=lambda *a:AuthenticationResult("ready"))\n'
              'try:\n'
              ' with owner.lease(): raise SystemExit("unexpectedly acquired shared grant")\n'
              'except RecoveryError as e:\n'
              ' assert str(e)=="recovery_scope_in_use"\n')
    with executor.owner.lease():
        result = subprocess.run([sys.executable, '-c', script, executor.owner.key, str(executor.owner.store.root)],
                                text=True, capture_output=True, timeout=5)
    assert result.returncode == 0, result.stdout+result.stderr
