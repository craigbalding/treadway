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
        restarted = manager.start("a", executable=executable, persistent=True, sandbox=sandbox)
        assert restarted.profile == a.profile and restarted.generation != a.generation
        assert storage(restarted) == "retained"
        with pytest.raises(RuntimeError, match="stale"):
            manager.stop(a)
        a = restarted
    finally:
        manager.stop(a)
        if b:
            manager.stop(b)
        server.shutdown()
        server.server_close()
        worker.join()
