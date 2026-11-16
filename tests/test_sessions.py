from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
import time

import pytest

from treadway.sessions import HttpSession


@pytest.fixture
def app():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            calls.append((self.path, self.headers.get("Cookie")))
            if self.path == "/slow-headers":
                try:
                    self.wfile.write(b"HTTP/1.1 200 OK\r\n")
                    for _ in range(10):
                        self.wfile.write(b"X-Slow: synthetic\r\n")
                        self.wfile.flush()
                        time.sleep(.04)
                    self.wfile.write(b"Content-Length: 0\r\n\r\n")
                except OSError:
                    pass
                return
            self.send_response(302 if self.path == "/redirect" else 428 if self.path == "/blocked" else 200)
            if self.path == "/blocked":
                self.send_header("X-Blocked-By", "synthetic-policy")
                self.send_header("X-Trace", "first")
                self.send_header("X-Trace", "second")
            if self.path == "/login":
                self.send_header("Set-Cookie", "user=a; HttpOnly; Path=/")
            if self.path == "/redirect":
                self.send_header("Location", "/must-not-follow")
            if self.path == "/partial":
                self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(json.dumps({"principal": "a" if self.headers.get("Cookie") == "user=a" else None}).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", calls
    server.shutdown()
    server.server_close()
    thread.join()


def test_cookie_jars_are_separate_and_wrong_actor_never_dispatches(app):
    origin, calls = app
    a, b = [HttpSession(actor=name, origin=origin) for name in ("a", "b")]
    a.request("/login")
    assert a.attempt("/resource", probe="/session", expected={"principal": "a"}).status == 200
    with pytest.raises(RuntimeError, match="principal_unknown"):
        b.attempt("/resource", probe="/session", expected={"principal": "a"})
    assert [path for path, _ in calls].count("/resource") == 1
    assert b.request("/session").json() == {"principal": None}


def test_no_redirect_no_cross_origin_and_incomplete_is_not_empty(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin, max_body_bytes=1)
    result = session.request("/redirect")
    assert result.status == 302 and not result.complete
    assert result.header("location") == "/must-not-follow"
    with pytest.raises(ValueError, match="incomplete"):
        result.json()
    assert len(calls) == 1


def test_response_headers_survive_errors_and_keep_duplicate_values_private(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin)
    blocked = session.request("/blocked")
    assert blocked.status == 428 and blocked.complete
    assert blocked.header("x-BLOCKED-by") == "synthetic-policy"
    assert blocked.header("missing", "absent") == "absent"
    assert tuple(value for key, value in blocked.headers if key.lower() == "x-trace") == ("first", "second")
    login = session.request("/login")
    assert login.header("set-cookie") == "user=a; HttpOnly; Path=/"
    assert "user=a" not in repr(login) and "synthetic-policy" not in repr(blocked)
    assert len(calls) == 2


def test_slow_headers_cannot_extend_the_feedback_deadline(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin)
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="incomplete"):
        session.request("/slow-headers", timeout_seconds=.1)
    assert time.monotonic()-started < .3
    assert len(calls) == 1


def test_partial_http_response_and_credential_errors_never_look_complete(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin)
    response = session.request("/partial")
    assert not response.complete and response.body
    def broken_credentials():
        raise ValueError("synthetic-private-credential")
    session = HttpSession(actor="visitor", origin=origin, credential_headers=broken_credentials)
    with pytest.raises(RuntimeError) as failure:
        session.request("/session")
    assert "synthetic-private-credential" not in str(failure.value)
    for path in ("https://other.invalid", "//other.invalid/path"):
        with pytest.raises(ValueError, match="same_origin"):
            session.request(path)
    assert len(calls) == 1


def test_failure_retains_probe_and_distinguishes_missing_from_wrong(app):
    from treadway.sessions import HttpFailure
    origin, calls = app
    session = HttpSession(actor='a', origin=origin)
    with pytest.raises(HttpFailure) as failure:
        session.attempt('/resource', probe='/blocked', expected={'principal': 'a'})
    assert failure.value.phase == 'probe'
    assert failure.value.dispatch == 'not_started'
    assert failure.value.observation.status == 428
    assert failure.value.observation.header('X-Trace') == 'first'
    with pytest.raises(HttpFailure) as failure:
        session.attempt('/resource', probe='/session', expected={'principal': 'a'})
    assert failure.value.principal == 'unknown'  # explicit null requires app classification
    assert all(path != '/resource' for path, _ in calls)


def test_header_acquisition_once_and_failed_prerequisite_never_dispatches(app):
    from treadway.sessions import HttpFailure
    origin, calls = app
    reads = []
    session = HttpSession(actor='a', origin=origin,
                          credential_headers=lambda: reads.append(True) or {})
    session.request('/login')
    reads.clear()
    session.attempt('/resource', probe='/session', expected={'principal': 'a'})
    assert reads == [True]
    def refuse():
        raise RuntimeError('private prerequisite detail')
    with pytest.raises(HttpFailure) as failure:
        session.attempt('/resource', probe='/session', expected={'principal': 'a'}, before_dispatch=refuse)
    assert failure.value.phase == 'prerequisite'
    assert failure.value.dispatch == 'not_started'
    assert failure.value.observation.status == 200
    assert 'private prerequisite' not in str(failure.value)
    assert [path for path, _ in calls].count('/resource') == 1


def test_credentials_failure_is_definitely_before_dispatch(app):
    from treadway.sessions import HttpFailure
    origin, calls = app
    def unavailable():
        raise RuntimeError('secret value')
    session = HttpSession(actor='a', origin=origin, credential_headers=unavailable)
    with pytest.raises(HttpFailure) as failure:
        session.request('/resource')
    assert failure.value.phase == 'credentials' and failure.value.dispatch == 'not_started'
    assert not calls and 'secret value' not in str(failure.value)


def test_wrong_identity_dominates_missing_fields_in_any_order():
    from types import SimpleNamespace
    from treadway.sessions import principal_state
    for values in ({'tenant.id': 'tenant', 'user.id': 'expected'},
                   {'user.id': 'expected', 'tenant.id': 'tenant'}):
        observation = SimpleNamespace(complete=True, status=200, json=lambda: {'user': {'id': 'other'}})
        assert principal_state(observation, values) == 'wrong'
