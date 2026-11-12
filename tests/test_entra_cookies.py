from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from treadway.sessions import HttpSession


def snapshot(origin, cookies):
    return {'version': 'treadway.cookies/1', 'complete': True, 'actor': 'member',
            'generation': 'synthetic-generation', 'origin': origin, 'cookies': cookies}


def cookie(value, **extra):
    return {'name': 'session', 'value': value, 'domain': '127.0.0.1', 'path': '/',
            'secure': False, 'httpOnly': True, 'session': True, 'expires': -1,
            'sameSite': 'Lax', **extra}


def test_cookie_import_preserves_duplicate_paths_and_secure_expiry_rules():
    observed = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            observed.append(self.headers.get('Cookie'))
            self.send_response(200)
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        origin = f'http://127.0.0.1:{server.server_port}'
        session = HttpSession(actor='member', origin=origin)
        imported = session.import_browser_cookies(snapshot(origin, [cookie('root'), cookie('api', path='/api'),
            cookie('secure', name='secure', secure=True), cookie('expired', name='old', session=False, expires=1)]),
            generation='synthetic-generation')
        assert imported['complete'] and imported['imported'] == 4
        session.request('/api/resource')
        session.request('/other')
        assert observed == ['session=api; session=root', 'session=root']
        assert next(iter(session._jar)).get_nonstandard_attr('sameSite') == 'Lax'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize('change', [
    {'actor': 'another'}, {'origin': 'https://another.example.invalid'}, {'generation': 'another'},
    {'complete': False}, {'cookies': [cookie('partitioned', partitionKey={'topLevelSite': 'https://example.invalid'})]},
    {'cookies': [cookie('foreign', domain='another.example.invalid')]},
    {'cookies': [cookie('unsafe\r\nHeader: value')]},
])
def test_cookie_import_refuses_incomplete_unsupported_or_wrong_binding_atomically(change):
    origin = 'http://127.0.0.1'
    session = HttpSession(actor='member', origin=origin)
    valid = snapshot(origin, [cookie('original')])
    session.import_browser_cookies(valid, generation='synthetic-generation')
    with pytest.raises(ValueError):
        session.import_browser_cookies({**valid, **change}, generation='synthetic-generation')
    assert [c.value for c in session._jar] == ['original']


def test_principal_cookie_alone_is_not_protected_api_state_and_full_import_supplies_companions():
    """A valid principal probe must not stand in for exporting the complete jar."""
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            header = self.headers.get('Cookie') or ''
            principal = 'session=member' in header
            complete = principal and all(value in header for value in
                                        ['cached_principal=cache', 'account.0=first', 'account.1=second', 'session=api'])
            allowed = principal if self.path == '/principal' else complete
            self.send_response(200 if allowed else 401)
            self.end_headers()
            self.wfile.write(b'{"id":"member"}' if allowed else b'{}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        origin = f'http://127.0.0.1:{server.server_port}'
        session = HttpSession(actor='member', origin=origin)
        session.import_browser_cookies(snapshot(origin, [cookie('member')]), generation='synthetic-generation')
        assert session.request('/principal').status == 200
        assert session.request('/api/protected').status == 401
        complete = [cookie('member'), cookie('api', path='/api'), cookie('cache', name='cached_principal'),
                    cookie('first', name='account.0'), cookie('second', name='account.1')]
        session.import_browser_cookies(snapshot(origin, complete), generation='synthetic-generation')
        assert session.attempt('/api/protected', probe='/principal', expected={'id': 'member'}).status == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
