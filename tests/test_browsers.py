"""Lifecycle regressions run without a browser; acceptance uses real Chromium."""
from dataclasses import replace
import os

import pytest

from treadway.browsers import BrowserManager, BrowserSession, private_json, process_identity


def test_construction_is_passive_and_paths_are_scoped(tmp_path):
    root = tmp_path / "sessions"
    manager = BrowserManager(root)
    assert not root.exists()
    assert manager.sessions() == []
    for name in ("../other", "", "a/b", "a:b"):
        with pytest.raises(ValueError):
            manager.attach(name)
    link = tmp_path / "link"
    link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        BrowserManager(link).attach("a")


@pytest.mark.parametrize('budget', [0, -1, 61, True, '5', float('inf'), float('nan')])
def test_verification_budget_validation_is_passive(tmp_path, budget):
    root = tmp_path / 'not-created'
    with pytest.raises(ValueError, match='bounded_browser_verification_required'):
        BrowserManager(root, verification_seconds=budget)
    assert not root.exists()


def verified_fixture(manager, monkeypatch, clock, durations):
    session = BrowserSession('synthetic', 'synthetic-generation', '/synthetic-profile', 1,
                             ('synthetic-boot', 'synthetic-start'), 9222, '/devtools/browser/owned', 'exact-target', True)
    calls = []
    monkeypatch.setattr('treadway.browsers.time.monotonic', lambda: clock[0])
    monkeypatch.setattr(manager, '_owned', lambda handle: True)

    def get(port, endpoint, timeout):
        calls.append((endpoint, timeout))
        clock[0] += durations[len(calls)-1]
        return {'webSocketDebuggerUrl': 'ws://127.0.0.1/devtools/browser/owned'} if endpoint == '/json/version' else [
            {'type': 'page', 'id': 'exact-target'}, {'type': 'page', 'id': 'decoy'}]

    monkeypatch.setattr(manager, '_get', get)
    return session, calls


def test_owned_verification_uses_one_remaining_budget_for_both_endpoints(tmp_path, monkeypatch):
    manager = BrowserManager(tmp_path, verification_seconds=5)
    session, calls = verified_fixture(manager, monkeypatch, [100], [1.4, 1.4])
    assert manager._verify(session) is session
    assert calls == [('/json/version', 5), ('/json/list', pytest.approx(3.6))]


def test_startup_remaining_budget_caps_owned_verification(tmp_path, monkeypatch):
    manager = BrowserManager(tmp_path, verification_seconds=5)
    session, calls = verified_fixture(manager, monkeypatch, [100], [.7, .4])
    with pytest.raises(RuntimeError, match='browser_verification_timeout; endpoint=/json/list; generation=synthetic-generation'):
        manager._verify(session, deadline=101)
    assert calls == [('/json/version', 1), ('/json/list', pytest.approx(.3))]


def test_verification_failure_retains_only_safe_endpoint_metadata(tmp_path, monkeypatch):
    from urllib.error import HTTPError
    manager = BrowserManager(tmp_path, verification_seconds=5)
    session, calls = verified_fixture(manager, monkeypatch, [100], [0, 0])

    def unavailable(*args, **kwargs):
        raise HTTPError('http://synthetic.invalid/private-token', 503, 'private-token', {}, None)

    monkeypatch.setattr(manager, '_get', unavailable)
    with pytest.raises(RuntimeError) as failed:
        manager._verify(session)
    assert 'status=503' in str(failed.value) and 'endpoint=/json/version' in str(failed.value)
    assert 'private-token' not in str(failed.value)
    monkeypatch.setattr(manager, '_owned', lambda handle: False)
    with pytest.raises(RuntimeError, match='owned_browser_process_not_established'):
        manager._verify(session)
    assert calls == []


def test_owned_endpoint_trickled_body_cannot_restart_the_verification_budget(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    import time

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            try:
                for byte in b'{"synthetic":"slow"}':
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(.04)
            except OSError:
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            BrowserManager._get(server.server_port, '/json/list', timeout=.12)
        assert time.monotonic() - started < .5
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def test_exclusive_lease_and_private_manifest(tmp_path):
    manager = BrowserManager(tmp_path)
    with manager._lock("a") as directory:
        with pytest.raises(RuntimeError, match="session_in_use"):
            with manager._lock("a"):
                pass
        private_json(directory / "session.json", {"private": "synthetic"})
        assert (directory / "session.json").stat().st_mode & 0o777 == 0o600
        assert directory.stat().st_mode & 0o777 == 0o700


def test_foreign_process_is_never_stopped(tmp_path):
    manager = BrowserManager(tmp_path)
    session = BrowserSession("a", "generation", "/not-this-process", os.getpid(),
                             process_identity(os.getpid()), 1, "/devtools/browser/a", "target", False)
    from dataclasses import asdict
    with manager._lock("a") as directory:
        private_json(directory / "session.json", {"session": asdict(session)})
    with pytest.raises(RuntimeError, match="ownership|owned_browser"):
        manager.stop(session)
    with pytest.raises(RuntimeError, match="stale"):
        manager.stop(replace(session, generation="stale"))


def test_startup_failure_is_bounded_and_never_changes_sandbox(tmp_path):
    executable = tmp_path / "fake-browser"
    executable.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 1\n")
    executable.chmod(0o700)
    manager = BrowserManager(tmp_path / "sessions")
    with pytest.raises(RuntimeError, match="no automatic sandbox fallback"):
        manager.start("a", executable=executable, startup_seconds=.2)
    logs = list((tmp_path / "sessions/a").glob("chrome-*.log"))
    assert len(logs) == 1
    assert "--no-sandbox" not in logs[0].read_text()
    assert "--remote-debugging-address=127.0.0.1" in logs[0].read_text()
    assert all(not entry["running"] for entry in manager.sessions())


def test_require_new_refuses_to_adopt_a_running_browser_and_preserves_profile(tmp_path):
    manager = BrowserManager(tmp_path / 'sessions')
    executable = synthetic_browser(tmp_path)
    session = manager.start('identity', executable=executable, persistent=True)
    try:
        with pytest.raises(RuntimeError, match='browser_session_already_running'):
            manager.start('identity', executable=executable, persistent=True, require_new=True)
        assert manager.attach('identity') == session
    finally:
        manager.stop(session)
    assert os.path.isdir(session.profile)


@pytest.mark.parametrize('eventually_ready', [True, False])
def test_startup_polls_only_incomplete_owned_endpoint_until_its_deadline(tmp_path, monkeypatch, eventually_ready):
    import time
    executable = synthetic_browser(tmp_path)
    manager = BrowserManager(tmp_path / 'sessions', verification_seconds=5)
    original = manager._get
    versions = []

    def transient(port, endpoint, timeout=1):
        if endpoint == '/json/version':
            versions.append(timeout)
            if not eventually_ready or len(versions) == 1:
                raise TimeoutError('synthetic transient owned endpoint')
        return original(port, endpoint, timeout=timeout)

    monkeypatch.setattr(manager, '_get', transient)
    started = time.monotonic()
    if eventually_ready:
        session = manager.start('a', executable=executable, startup_seconds=2)
        try:
            assert len(versions) == 2
            assert all(timeout <= 2 for timeout in versions)
        finally:
            manager.stop(session)
    else:
        with pytest.raises(RuntimeError, match='browser_startup_incomplete'):
            manager.start('a', executable=executable, startup_seconds=1)
        assert versions
        assert time.monotonic() - started < 2
        assert all(not entry['running'] for entry in manager.sessions())


def synthetic_browser(tmp_path, matching_page=True, lingering_child=False):
    import sys
    executable = tmp_path / "synthetic-browser"
    executable.write_text(f"#!{sys.executable}\n" + '''
import json, os, signal, socket, sys, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
profile = Path(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--user-data-dir=')))
marker = sys.argv[-1]
(profile / 'startup-marker').write_text(marker)
scratch = Path(os.environ['TMPDIR'])
(profile / 'scratch-path').write_text(str(scratch))
socket_root = scratch / 'org.chromium.Chromium.synthetic'
socket_root.mkdir()
singleton = socket.socket(socket.AF_UNIX)
singleton.bind(str(socket_root / 'SingletonSocket'))
if LINGERING_CHILD:
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (profile / 'child-pid').write_text(str(os.getpid()))
        while True:
            signal.pause()
    while not (profile / 'child-pid').exists():
        time.sleep(.01)
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_GET(self):
        if self.path == '/json/version':
            value = {'webSocketDebuggerUrl': 'ws://127.0.0.1:%s/devtools/browser/synthetic' % self.server.server_port}
        else:
            value = [{'type': 'page', 'url': 'chrome://newtab/', 'id': 'decoy'},
                     {'type': 'browser_ui', 'url': marker, 'id': 'toolbar'},
                     {'type': 'page', 'url': marker + '-changed', 'id': 'changed'}]
            if MATCHING_PAGE:
                value.append({'type': 'page', 'url': marker, 'id': 'owned'})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
server = HTTPServer(('127.0.0.1', 0), Handler)
(profile / 'DevToolsActivePort').write_text(str(server.server_port) + '\\n/devtools/browser/synthetic')
server.serve_forever()
'''.replace('MATCHING_PAGE', repr(matching_page)).replace('LINGERING_CHILD', repr(lingering_child)))
    executable.chmod(0o700)
    return executable


@pytest.mark.parametrize("matching_page", [True, False])
def test_startup_requires_exact_inert_marker_and_ignores_other_targets(tmp_path, matching_page):
    import json
    from pathlib import Path
    executable = synthetic_browser(tmp_path, matching_page)
    manager = BrowserManager(tmp_path / ("nested-" + "x" * 110))
    scratch = None
    session = None
    try:
        if matching_page:
            session = manager.start("a", executable=executable, startup_seconds=2)
            assert session.target_id == "owned"
        else:
            with pytest.raises(RuntimeError, match="browser_startup_incomplete"):
                manager.start("a", executable=executable, startup_seconds=2)
        record = json.loads((manager.root / "a/session.json").read_text())
        assert record["options"]["sandbox"] is True
        marker = (Path(record["session"]["profile"]) / "startup-marker").read_text()
        assert marker == "data:text/html,treadway-" + record["session"]["generation"]
        scratch = Path(record["scratch"])
        if matching_page:
            assert scratch.stat().st_mode & 0o777 == 0o700
    finally:
        if session is not None:
            manager.stop(session)
    assert all(not entry["running"] for entry in manager.sessions())
    assert scratch is not None and not scratch.exists()


def test_stop_kills_owned_child_after_parent_exits_on_interrupt(tmp_path):
    import json
    from pathlib import Path
    import signal
    executable = synthetic_browser(tmp_path, lingering_child=True)
    manager = BrowserManager(tmp_path / "sessions")
    session = manager.start("a", executable=executable, startup_seconds=2)
    child = int((Path(session.profile) / "child-pid").read_text())
    identity = process_identity(child)
    scratch = Path(json.loads((manager.root / "a/session.json").read_text())["scratch"])
    try:
        assert identity is not None and os.getpgid(child) == session.pid
        manager.stop(session)
        assert process_identity(session.pid) is None
        assert process_identity(child) is None
        assert not scratch.exists()
    finally:
        # A failed cleanup assertion must not leave this test's child running.
        if process_identity(child) == identity:
            os.kill(child, signal.SIGKILL)
        if process_identity(session.pid) == session.process_identity:
            manager.stop(session)


def test_group_cleanup_rejects_reused_pid_and_changed_group(monkeypatch):
    import treadway.browsers as browsers
    identities = {101: ("boot", "new-start"), 102: ("boot", "original"),
                  103: ("boot", "original")}
    groups = {101: 100, 102: 200, 103: 100}
    monkeypatch.setattr(browsers, "process_identity", identities.get)
    monkeypatch.setattr(browsers.os, "getpgid", groups.__getitem__)
    members = {pid: ("boot", "original") for pid in identities}
    assert BrowserManager._live_members(100, members) == [103]


def test_stop_never_signals_a_reused_main_pid(tmp_path, monkeypatch):
    from dataclasses import asdict
    import treadway.browsers as browsers
    manager = BrowserManager(tmp_path)
    session = BrowserSession("a", "generation", "/not-this-process", os.getpid(),
                             ("previous-boot", "previous-start"), 1,
                             "/devtools/browser/a", "target", False)
    with manager._lock("a") as directory:
        private_json(directory / "session.json", {"session": asdict(session)})

    def forbidden(*args):
        raise AssertionError("must not signal or enumerate a reused process")

    monkeypatch.setattr(browsers.os, "kill", forbidden)
    monkeypatch.setattr(browsers.os, "killpg", forbidden)
    monkeypatch.setattr(manager, "_group_members", forbidden)
    manager.stop(session)


def test_restart_after_external_exit_removes_old_scratch(tmp_path):
    import json
    from pathlib import Path
    import signal
    executable = synthetic_browser(tmp_path)
    manager = BrowserManager(tmp_path / "sessions")
    first = manager.start("a", executable=executable, startup_seconds=2)
    old_scratch = Path(json.loads((manager.root / "a/session.json").read_text())["scratch"])
    os.killpg(first.pid, signal.SIGKILL)
    os.waitpid(first.pid, 0)
    second = None
    try:
        second = manager.start("a", executable=executable, startup_seconds=2)
        new_scratch = Path(json.loads((manager.root / "a/session.json").read_text())["scratch"])
        assert not old_scratch.exists()
        assert new_scratch.is_dir()
    finally:
        if second is not None:
            manager.stop(second)
        else:
            manager.stop(first)
    assert not new_scratch.exists()


def test_scratch_cleanup_refuses_foreign_directory_or_symlink(tmp_path):
    from pathlib import Path
    import tempfile
    generation = "f" * 32
    record = {"session": {"generation": generation}, "scratch": str(tmp_path)}
    with pytest.raises(ValueError, match="owned_scratch_directory_required"):
        BrowserManager._clean_scratch(record)
    link = Path(tempfile.mkdtemp(prefix="tw-" + generation + "-", dir="/tmp"))
    link.rmdir()
    link.symlink_to(tmp_path, target_is_directory=True)
    try:
        record["scratch"] = str(link)
        with pytest.raises(ValueError, match="owned_scratch_directory_required"):
            BrowserManager._clean_scratch(record)
        assert tmp_path.is_dir()
    finally:
        link.unlink()


@pytest.mark.skipif(not os.environ.get("CHROME_BIN"), reason="CHROME_BIN required")
def test_real_profile_isolation_restart_and_stale_handle(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    import time
    from treadway.cdp import CdpSocket, CommandSession

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"<!doctype html><title>Synthetic sessions</title>")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f"http://127.0.0.1:{server.server_port}"

    def storage(session, value=None):
        socket = CdpSocket(host="127.0.0.1", port=session.port, target_id=session.target_id)
        try:
            commands = CommandSession(socket)
            commands.command("Page.navigate", {"url": origin})
            deadline = time.monotonic()+3
            while time.monotonic() < deadline:
                ready = commands.command("Runtime.evaluate", {"expression": f"location.origin === {origin!r} && document.readyState === 'complete'", "returnByValue": True})
                if ready.get("result", {}).get("value") is True:
                    break
                time.sleep(.025)
            else:
                raise AssertionError("fixture_document_not_committed")
            expression = "localStorage.getItem('synthetic')" if value is None else f"localStorage.setItem('synthetic', {value!r}); true"
            return commands.command("Runtime.evaluate", {"expression": expression, "returnByValue": True})["result"].get("value")
        finally:
            socket.close()

    manager = BrowserManager(tmp_path)
    executable = os.environ["CHROME_BIN"]
    sandbox = os.environ.get("TREADWAY_CHROME_SANDBOX", "on") != "off"
    a = manager.start("a", executable=executable, persistent=True, sandbox=sandbox)
    b = None
    try:
        b = manager.start("b", executable=executable, sandbox=sandbox)
        assert a.port != b.port and a.profile != b.profile
        assert storage(a, "retained") is True
        assert storage(b) is None
        assert manager.attach("a") == a
        assert manager.start("a", executable=executable, persistent=True, sandbox=sandbox) == a
        with pytest.raises(RuntimeError, match="configuration"):
            manager.start("a", executable=executable, persistent=True, sandbox=not sandbox)
        with manager.drive(a):
            with pytest.raises(RuntimeError, match="session_in_use"):
                manager.stop(a)
        manager.stop(a)
        old = a
        a = manager.start("a", executable=executable, persistent=True, sandbox=sandbox)
        assert a.profile == old.profile and a.generation != old.generation
        assert storage(a) == "retained"
        with pytest.raises(RuntimeError, match="stale"):
            manager.stop(old)
    finally:
        manager.stop(a)
        if b:
            manager.stop(b)
        server.shutdown()
        server.server_close()
        worker.join()
