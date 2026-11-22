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

        def method_response(self):
            calls.append((self.path, self.headers.get("Cookie")))
            self.send_response(200)
            self.send_header("X-Observed-Method", self.command)
            if self.command == "HEAD":
                # HEAD describes the corresponding GET representation but
                # must not send those bytes as its own response body.
                self.send_header("Content-Length", "4096")
                self.end_headers()
                return
            if self.command == "OPTIONS":
                self.send_header("Allow", "GET, HEAD, OPTIONS, TRACE")
                body = b""
            else:
                self.send_header("Content-Type", "message/http")
                body = (self.requestline + "\r\nX-Method-Fixture: " +
                        self.headers.get("X-Method-Fixture", "absent") + "\r\n").encode()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_HEAD = method_response
        do_OPTIONS = method_response
        do_TRACE = method_response

        def do_GET(self):
            calls.append((self.path, self.headers.get("Cookie")))
            if self.path.startswith("/page/"):
                body = b"<html>" + b"x" * int(self.path.rsplit("/", 1)[1]) + b"</html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
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


@pytest.mark.parametrize("size", [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024])
def test_default_budget_retains_complete_pages_and_bundles_without_repeating(app, size):
    origin, calls = app
    response = HttpSession(actor="visitor", origin=origin).request(f"/page/{size}")
    assert response.complete
    assert response.body == b"<html>" + b"x" * size + b"</html>"
    assert len(calls) == 1


def test_cookie_jars_are_separate_and_wrong_actor_never_dispatches(app):
    origin, calls = app
    a, b = [HttpSession(actor=name, origin=origin) for name in ("a", "b")]
    a.request("/login")
    assert a.attempt("/resource", probe="/session", expected={"principal": "a"}).status == 200
    with pytest.raises(RuntimeError, match="principal_unknown"):
        b.attempt("/resource", probe="/session", expected={"principal": "a"})
    assert [path for path, _ in calls].count("/resource") == 1
    assert b.request("/session").json() == {"principal": None}


def test_explicit_long_request_budget_is_allowed_and_success_does_not_wait(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin)
    started = time.monotonic()
    assert session.request("/session", timeout_seconds=120).complete
    assert time.monotonic() - started < 5
    assert len(calls) == 1


def test_no_redirect_no_cross_origin_and_incomplete_is_not_empty(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin, max_body_bytes=1)
    result = session.request("/redirect")
    assert result.status == 302 and not result.complete
    assert result.body_truncated and result.body_limit_bytes == 1
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


@pytest.mark.parametrize("method", ["HEAD", "OPTIONS", "TRACE"])
@pytest.mark.parametrize("authenticated", [False, True])
def test_standard_methods_dispatch_once_and_preserve_their_response(app, method, authenticated):
    origin, calls = app
    session = HttpSession(actor="a", origin=origin)
    headers = {"X-Method-Fixture": "synthetic-marker"}
    if authenticated:
        session.request("/login")
        response = session.attempt("/method", probe="/session", expected={"principal": "a"},
                                   method=method, headers=headers)
    else:
        response = session.request("/method", method=method, headers=headers)
    assert response.status == 200 and response.complete
    assert response.header("X-Observed-Method") == method
    assert [path for path, _ in calls].count("/method") == 1
    if method == "HEAD":
        assert response.body == b""
        assert response.header("Content-Length") == "4096"
    elif method == "OPTIONS":
        assert response.body == b""
        assert response.header("Allow") == "GET, HEAD, OPTIONS, TRACE"
    else:
        assert response.body.startswith(b"TRACE /method HTTP/")
        assert b"X-Method-Fixture: synthetic-marker" in response.body


@pytest.mark.parametrize("method", ["HEAD", "OPTIONS", "TRACE"])
def test_standard_methods_do_not_bypass_identity_or_reconciliation_guards(app, method):
    from treadway.sessions import HttpFailure
    origin, calls = app
    session = HttpSession(actor="a", origin=origin)
    session.request("/login")
    with pytest.raises(HttpFailure, match="actual_principal_differs"):
        session.attempt("/method", probe="/session", expected={"principal": "other"}, method=method)
    assert all(path != "/method" for path, _ in calls)
    count = len(calls)
    with session.observation_only(), pytest.raises(HttpFailure, match="read_only_observation_required"):
        session.request("/method", method=method)
    assert len(calls) == count


def test_additional_methods_keep_origin_deadline_and_body_limits(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin, max_body_bytes=10)
    for method, path, timeout in [("CONNECT", "/method", 5), ("OPTIONS", "/method", 0),
                                  ("TRACE", "/method", 3601), ("HEAD", "//other.invalid/", 5)]:
        with pytest.raises(ValueError):
            session.request(path, method=method, timeout_seconds=timeout)
    assert not calls
    response = session.request("/method", method="TRACE")
    assert not response.complete and len(response.body) == 10
