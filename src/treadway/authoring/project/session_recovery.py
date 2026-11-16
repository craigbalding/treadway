"""Disposable local application and calibrated mutation keywords. No live targets.

Constructors/import/dry-run are passive. Open Recovery Example explicitly starts
this fixture. Real consumers replace its domain mappings and owner callbacks.
"""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sqlite3
from threading import Thread
import time
import uuid

from treadway.recovery import (Assessment, AuthenticationOwner, AuthenticationResult,
                               OperationExecutor, RecoveryPolicy)
from treadway.sessions import HttpFailure, HttpSession


class SessionRecoveryExample:
    ROBOT_LIBRARY_SCOPE = 'SUITE'

    def __init__(self):
        self.server = None
        self.thread = None
        self.executor = None

    def open_recovery_example(self):
        if self.server is not None:
            raise RuntimeError('example_already_open')
        root = Path(__file__).parent / 'artifacts' / ('session-recovery-' + uuid.uuid4().hex)
        root.mkdir(parents=True, mode=0o700)
        database = root / 'items.sqlite'
        database.touch(mode=0o600)
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE items (id TEXT PRIMARY KEY, value INTEGER NOT NULL)')
        state = {'token': 'synthetic-initial', 'refreshes': 0, 'writes': 0, 'lost': False}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, status, body, cookies=()):
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(encoded)))
                self.send_header('Content-Type', 'application/json')
                for cookie in cookies:
                    self.send_header('Set-Cookie', cookie)
                self.end_headers()
                self.wfile.write(encoded)

            def cookies(self):
                jar = SimpleCookie()
                jar.load(self.headers.get('Cookie', ''))
                return {key: value.value for key, value in jar.items()}

            def do_GET(self):
                if self.path == '/contract':
                    return self.respond(200, {'schemaVersion': state.get('schemaVersion', 1)})
                authenticated = self.cookies().get('session') == state['token']
                self.respond(200 if authenticated else 401,
                             {'principal': 'member'} if authenticated else {'error': 'session_expired'})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path == '/session':
                    return self.respond(200, {'principal': 'member'}, [
                        'session=synthetic-initial; Path=/; HttpOnly',
                        'refresh=synthetic-app-grant; Path=/refresh; HttpOnly'])
                if self.path == '/refresh':
                    if self.cookies().get('refresh') != 'synthetic-app-grant':
                        return self.respond(401, {'error': 'refresh_rejected'})
                    state['refreshes'] += 1
                    return self.respond(200, {'renewed': True}, [
                        f"session={state['token']}; Path=/; HttpOnly"])
                if self.cookies().get('session') != state['token']:
                    return self.respond(401, {'error': 'session_expired'})
                with sqlite3.connect(database) as db:
                    db.execute('INSERT INTO items VALUES (?, ?)', (body['id'], body['value']))
                state['writes'] += 1
                if state['writes'] == 37:
                    state['token'] = 'synthetic-renewed'
                if body['value'] == 63 and not state['lost']:
                    state['lost'] = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.respond(201, {'id': body['id']})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server = server
        self.thread = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.database, self.state = database, state
        session = HttpSession(actor='member', origin=f'http://127.0.0.1:{server.server_port}')
        session.request('/session', method='POST', body={'fixture': True})

        def renew(client, context):
            # An application's refresh and an IdP's refresh are distinct. This
            # fixture declares only its app refresh; no IdP exchange is invented.
            remaining = min(5, context.deadline-time.monotonic())
            if remaining <= 0:
                return AuthenticationResult('unavailable', 'application_refresh')
            observed = client.request('/refresh', method='POST', body={'fixture': True}, timeout_seconds=remaining)
            status = 'unknown'
            if observed.complete and observed.status == 200 and observed.json() == {'renewed': True}:
                status = 'ready'
            elif observed.complete and observed.status == 401 and observed.json() == {'error': 'refresh_rejected'}:
                status = 'rejected'
            return AuthenticationResult(status, 'application_refresh')

        owner = AuthenticationOwner('local-application/member/grant', root / 'authentication',
            prepare=lambda client, context: AuthenticationResult('ready', 'application_cookie_jar'),
            renew=renew, classify=lambda failure: failure.observation is not None
            and failure.observation.complete and failure.observation.status == 401
            and failure.observation.json() == {'error': 'session_expired'})

        def observe_effect(operation, previous, client):
            with sqlite3.connect(database) as db:
                row = db.execute('SELECT value FROM items WHERE id=?', (operation['body']['id'],)).fetchone()
            confirmed = row is not None and row[0] == operation['body']['value']
            return Assessment('confirmed' if confirmed else 'unknown',
                              evidence={'persisted_value': row[0] if row else None})

        def assess(operation, observation, client):
            if isinstance(observation, HttpFailure) or not observation.complete:
                return Assessment('unknown')
            if observation.status == 401 and observation.json() == {'error': 'session_expired'}:
                return Assessment('rejected', authentication_required=True, replay='not_applied',
                                  evidence={'contract': 'fixture-authentication-before-write'})
            return observe_effect(operation, None, client)

        self.executor = OperationExecutor(session, root / 'operations', probe='/principal',
            expected={'principal': 'member'}, owner=owner, assess=assess, reconcile=observe_effect,
            policy=RecoveryPolicy(maintain_authentication=True))

    def execute_recovery_binding(self, index: int):
        if self.executor is None:
            raise RuntimeError('example_not_open')
        return self.executor.execute(f'item-{index}', '/items',
                                     body={'id': f'item-{index}', 'value': index}, binding={'row': index})

    def verify_recovery_effects(self):
        with sqlite3.connect(self.database) as db:
            count, total = db.execute('SELECT count(*), sum(value) FROM items').fetchone()
        if (count, total, self.state['writes'], self.state['refreshes'], self.state['lost']) != (100, 5050, 100, 1, True):
            raise AssertionError('synthetic_recovery_effects_differ')
        return {'confirmed': count, 'writes': self.state['writes'], 'renewals': self.state['refreshes'],
                'lost_response_reconciled': self.state['lost']}

    def close_recovery_example(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                raise RuntimeError('example_cleanup_incomplete')
            self.server = None
