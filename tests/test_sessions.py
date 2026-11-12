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
            self.send_response(302 if self.path == "/redirect" else 200)
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
    with pytest.raises(RuntimeError, match="principal_differs"):
        b.attempt("/resource", probe="/session", expected={"principal": "a"})
    assert [path for path, _ in calls].count("/resource") == 1
    assert b.request("/session").json() == {"principal": None}


def test_no_redirect_no_cross_origin_and_incomplete_is_not_empty(app):
    origin, calls = app
    session = HttpSession(actor="visitor", origin=origin, max_body_bytes=1)
    result = session.request("/redirect")
    assert result.status == 302 and not result.complete
    with pytest.raises(ValueError, match="incomplete"):
        result.json()
    assert len(calls) == 1


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
