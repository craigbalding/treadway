"""Owned local Chromium processes and explicit profile/session lifetimes.

Construction is passive. Starting, attaching, stopping and forgetting state are
separate operations. A profile name is never evidence of application identity.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.request import ProxyHandler, build_opener
import uuid


def private_json(path: Path, value):
    """Publish private state atomically, without a world-readable first write."""
    scratch = path.with_name("." + uuid.uuid4().hex)
    try:
        fd = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(scratch, path)
    finally:
        scratch.unlink(missing_ok=True)


def process_identity(pid):
    """Linux PID plus boot/start identity; PID reuse must never authorize a kill."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] == "Z":
            return None
        return (Path("/proc/sys/kernel/random/boot_id").read_text().strip(), stat[19])
    except (OSError, IndexError):
        return None


@dataclass(frozen=True)
class BrowserSession:
    name: str
    generation: str
    profile: str
    pid: int
    process_identity: tuple[str, str]
    port: int
    browser_path: str
    target_id: str
    persistent: bool

    def __post_init__(self):
        object.__setattr__(self, "process_identity", tuple(self.process_identity))

    def connection(self):
        if not self.port or not self.target_id:
            raise RuntimeError("browser_startup_not_complete")
        return {"cdpHost": "127.0.0.1", "cdpPort": self.port, "targetId": self.target_id}


class BrowserManager:
    def __init__(self, root: Path):
        self.root = Path(root).absolute()

    def _directory(self, name):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", name):
            raise ValueError("path_safe_session_name_required")
        # Refuse symlinks in the entire managed path, including its ancestors.
        directory = self.root / name
        for path in [*reversed(directory.parents), directory]:
            if path.is_symlink():
                raise ValueError("session_path_symlink")
        return directory

    @contextmanager
    def _lock(self, name, filename="control.lock"):
        directory = self._directory(name)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        directory.chmod(0o700)
        fd = os.open(directory / filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("session_in_use") from None
            yield directory
        finally:
            os.close(fd)

    def _read(self, directory):
        path = directory / "session.json"
        if path.is_symlink():
            raise ValueError("session_manifest_symlink")
        return json.loads(path.read_text()) if path.exists() else None

    def _owned(self, session):
        if process_identity(session.pid) != session.process_identity:
            return False
        try:
            args = Path(f"/proc/{session.pid}/cmdline").read_bytes().split(b"\0")
            return f"--user-data-dir={session.profile}".encode() in args and os.getpgid(session.pid) == session.pid
        except OSError:
            return False

    @staticmethod
    def _get(port, path, timeout=1):
        # This transport is exclusively for an owned loopback debugging endpoint.
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=timeout) as response:
            return json.load(response)

    def _verify(self, session):
        if not session.port or not session.target_id:
            raise RuntimeError("browser_startup_not_complete; stop the recorded generation before retrying")
        if not self._owned(session):
            raise RuntimeError("owned_browser_process_not_established")
        version = self._get(session.port, "/json/version")
        if version.get("webSocketDebuggerUrl", "").rsplit("/devtools/browser/", 1)[-1] != session.browser_path.rsplit("/", 1)[-1]:
            raise RuntimeError("browser_endpoint_generation_differs")
        targets = self._get(session.port, "/json/list")
        if len([t for t in targets if t.get("type") == "page" and t.get("id") == session.target_id]) != 1:
            raise RuntimeError("explicit_session_target_missing")
        return session

    def attach(self, name):
        """Attach only to this manager's recorded process and exact target."""
        with self._lock(name) as directory:
            record = self._read(directory)
            if record is None:
                raise RuntimeError("session_not_started")
            return self._verify(BrowserSession(**record["session"]))

    def recorded(self, name):
        """Return the recorded handle for explicit shutdown, even if its tab closed."""
        with self._lock(name) as directory:
            record = self._read(directory)
            if record is None:
                raise RuntimeError("session_not_started")
            return BrowserSession(**record["session"])

    @contextmanager
    def drive(self, session):
        """Exclusive operation lease. Separate sessions can be driven concurrently."""
        with self._lock(session.name, "drive.lock"):
            current = self.attach(session.name)
            if current != session:
                raise RuntimeError("stale_browser_session")
            yield session

    def start(self, name, *, executable, persistent=False, headless=True, sandbox=True,
              disabled_features=(), proxy=None, startup_seconds=8):
        if type(startup_seconds) not in {int, float} or not 0 < startup_seconds <= 60:
            raise ValueError("bounded_startup_required")
        executable = str(Path(executable).absolute())
        if not os.access(executable, os.X_OK):
            raise ValueError("executable_browser_required")
        features = tuple(disabled_features)
        if any(not isinstance(f, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", f) for f in features):
            raise ValueError("explicit_feature_names_required")
        proxy = proxy if proxy is not None else (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
                                                 or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy", ""))
        bypass = os.environ.get("NO_PROXY", os.environ.get("no_proxy", ""))
        options = dict(executable=executable, persistent=bool(persistent), headless=bool(headless),
                       sandbox=bool(sandbox), disabled_features=list(features), proxy=proxy, proxy_bypass=bypass)
        with self._lock(name, "drive.lock"), self._lock(name) as directory:
            record = self._read(directory)
            if record:
                previous = BrowserSession(**record["session"])
                if self._owned(previous):
                    if record["options"] != options:
                        raise RuntimeError("running_browser_configuration_differs")
                    return self._verify(previous)
                if process_identity(previous.pid) == previous.process_identity:
                    raise RuntimeError("recorded_process_ownership_differs")
            generation = uuid.uuid4().hex
            profile = directory / ("persistent" if persistent else "profile-" + generation)
            if profile.is_symlink():
                raise ValueError("profile_symlink")
            profile.mkdir(mode=0o700, exist_ok=persistent)
            profile.chmod(0o700)
            # A stopped persistent profile can retain this previous-process file.
            active = profile / "DevToolsActivePort"
            if active.is_symlink():
                raise ValueError("debug_endpoint_symlink")
            active.unlink(missing_ok=True)
            scratch = directory / "scratch"
            scratch.mkdir(mode=0o700, exist_ok=True)
            marker = "about:blank#treadway-" + generation
            flags = [executable, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
                     "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1",
                     "--remote-debugging-port=0", "--user-data-dir=" + str(profile)]
            if headless:
                flags.append("--headless")
            if not sandbox:
                flags.append("--no-sandbox")
            if features:
                flags.append("--disable-features=" + ",".join(features))
            if proxy:
                flags.append("--proxy-server=" + proxy)
                if bypass:
                    flags.append("--proxy-bypass-list=" + bypass.replace(",", ";"))
            log = directory / ("chrome-" + generation + ".log")
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            process = None
            try:
                with os.fdopen(fd, "w") as stream:
                    process = subprocess.Popen([*flags, marker], stdout=stream, stderr=stream,
                                               start_new_session=True, env={**os.environ, "TMPDIR": str(scratch)})
                identity = process_identity(process.pid)
                if identity:
                    launching = BrowserSession(name, generation, str(profile), process.pid, identity,
                                               0, "", "", bool(persistent))
                    private_json(directory / "session.json", {"session": asdict(launching), "options": options,
                                                              "phase": "starting"})
                deadline = time.monotonic() + startup_seconds
                while time.monotonic() < deadline and process.poll() is None:
                    if active.exists():
                        try:
                            lines = active.read_text().splitlines()
                            port = int(lines[0])
                            browser_path = lines[1]
                            if not 0 < port <= 65535 or not re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]+", browser_path):
                                raise ValueError()
                            targets = self._get(port, "/json/list", timeout=min(1, max(.01, deadline-time.monotonic())))
                            matches = [t for t in targets if t.get("type") == "page" and t.get("url") == marker]
                            if len(matches) == 1:
                                session = BrowserSession(name, generation, str(profile), process.pid, identity,
                                                         port, browser_path, matches[0]["id"], bool(persistent))
                                self._verify(session)
                                private_json(directory / "session.json", {"session": asdict(session), "options": options,
                                                                          "phase": "ready"})
                                return session
                        except (OSError, ValueError, IndexError):
                            pass
                    time.sleep(.025)
                raise RuntimeError(f"browser_startup_incomplete; inspect {log}; no automatic sandbox fallback")
            except BaseException:
                if process is not None and process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
                raise

    def stop(self, session):
        """Stop only this generation; preserve its profile and diagnostics."""
        with self._lock(session.name, "drive.lock"), self._lock(session.name) as directory:
            record = self._read(directory)
            if record is None or BrowserSession(**record["session"]) != session:
                raise RuntimeError("stale_browser_session")
            if process_identity(session.pid) != session.process_identity:
                return  # Already exited. Never signal a reused PID.
            if not self._owned(session):
                raise RuntimeError("owned_browser_process_not_established")
            os.killpg(session.pid, signal.SIGTERM)
            deadline = time.monotonic() + 3
            while self._owned(session) and time.monotonic() < deadline:
                time.sleep(.025)
            if self._owned(session):
                os.killpg(session.pid, signal.SIGKILL)
            try:
                os.waitpid(session.pid, 0)
            except ChildProcessError:
                pass

    def sessions(self):
        if not self.root.exists():
            return []
        result = []
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir():
                continue
            with self._lock(directory.name) as path:
                record = self._read(path)
                if record:
                    session = BrowserSession(**record["session"])
                    result.append({"session": asdict(session), "running": self._owned(session),
                                   "phase": record.get("phase", "ready")})
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start")
    start.add_argument("name")
    start.add_argument("--executable", required=True)
    start.add_argument("--persistent", action="store_true")
    start.add_argument("--headful", action="store_true")
    start.add_argument("--no-sandbox", action="store_true")
    start.add_argument("--disable-feature", action="append", default=[])
    for command in ("attach", "stop"):
        child = commands.add_parser(command)
        child.add_argument("name")
        if command == "stop":
            child.add_argument("--generation")
    commands.add_parser("list")
    args = parser.parse_args(argv)
    manager = BrowserManager(args.root)
    try:
        if args.command == "start":
            result = asdict(manager.start(args.name, executable=args.executable, persistent=args.persistent,
                                         headless=not args.headful, sandbox=not args.no_sandbox,
                                         disabled_features=args.disable_feature))
        elif args.command == "attach":
            result = asdict(manager.attach(args.name))
        elif args.command == "stop":
            session = manager.recorded(args.name)
            if args.generation and session.generation != args.generation:
                raise RuntimeError("stale_browser_session")
            manager.stop(session)
            result = {"stopped": args.name}
        else:
            result = manager.sessions()
        print(json.dumps(result))
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
