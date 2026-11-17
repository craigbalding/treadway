"""Provider-neutral browser ownership. Configuration and construction are passive.

Only explicit acquire/drive/release operations start processes or resolve endpoint
credentials. Remote descriptors are private inputs to the shared Node connection
factory; they contain no provider URL or token.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit

from .browsers import BrowserManager, BrowserSession, private_json
from .credentials import CredentialRef, EnvironmentProvider
from .browser_state import BrowserIdentity, IdentityLease
from .process import run_json_process


class BrowserRuntimeIncomplete(RuntimeError):
    """Safe summary with retained private evidence, never provider exception text."""

    def __init__(self, code, *, evidence=None, details=None):
        self.code = code
        self.evidence = str(evidence) if evidence else None
        self.details = dict(details or {})
        super().__init__(code)


def _seconds(value, maximum):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= maximum:
        raise ValueError("bounded_browser_deadline_required")
    return float(value)


def _private_directory(directory):
    directory = Path(directory).absolute()
    for component in (*reversed(directory.parents), directory):
        if component.is_symlink():
            raise ValueError("private_browser_state_directory_required")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise ValueError("private_browser_state_directory_required")
    return directory


def _project_identity(project_root, deadline):
    directory = _private_directory(Path(project_root) / ".treadway")
    lock = os.open(directory / "project.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrowserRuntimeIncomplete("project_identity_deadline") from None
                time.sleep(min(.01, remaining))
        state = directory / "project.json"
        if state.exists() or state.is_symlink():
            if state.is_symlink() or not state.is_file() or state.stat().st_mode & 0o077:
                raise ValueError("private_project_identity_required")
            data = json.loads(state.read_text())
            identifier = data.get("projectId")
            if data.get("version") != 1 or not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier:
                raise ValueError("project_identity_invalid")
        else:
            identifier = str(uuid.uuid4())
            private_json(state, {"version": 1, "projectId": identifier})
        ignored = directory / ".gitignore"
        if not ignored.exists():
            descriptor = os.open(ignored, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                stream.write("*\n")
        return identifier
    finally:
        os.close(lock)


@dataclass
class RuntimeSession:
    name: str
    provider: str
    generation: str
    _connection: dict = field(repr=False)
    capabilities: dict = field(default_factory=dict)
    _local: BrowserSession | None = field(default=None, repr=False)
    _identity_lease: IdentityLease | None = field(default=None, repr=False)
    _context_lease: IdentityLease | None = field(default=None, repr=False)
    _identity_principal: dict | None = field(default=None, repr=False)
    _identity_failed: bool = field(default=False, repr=False)

    def connection(self):
        """Private subprocess input; do not pass this mapping as Robot arguments."""
        return dict(self._connection)


class BrowserRuntime:
    def __init__(self, root: Path, *, configuration=None, project_root=None):
        config = dict(configuration or {})
        if "browser" in config:
            if len(config) != 1:
                raise ValueError("browser_configuration_invalid")
            config = dict(config["browser"])
        provider = config.get("provider", "local")
        if provider not in {"local", "browserless"}:
            raise ValueError("browser_provider_unsupported")
        if provider == 'local' and set(config) - {'provider', 'binding', 'acquire_seconds', 'session_seconds', 'cleanup_seconds'}:
            raise ValueError('local_browser_configuration_invalid')
        if provider == "browserless":
            allowed = {"provider", "binding", "endpoint_env", "attachment_env", "headers_env", "mode", "acquire_seconds", "session_seconds", "cleanup_seconds"}
            mode = config.get('mode', 'fresh')
            if set(config) - allowed or mode not in {'fresh', 'borrowed'}:
                raise ValueError("remote_browser_capability_unsupported")
            required = 'attachment_env' if mode == 'borrowed' else 'endpoint_env'
            if ('endpoint_env' if mode == 'borrowed' else 'attachment_env') in config:
                raise ValueError('remote_browser_configuration_conflicts')
            for key in (required, "headers_env"):
                value = config.get(key)
                if (key == required or value is not None) and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value)):
                    raise ValueError("browser_secret_reference_invalid")
        self.configuration = config
        self.provider = provider
        self.provider_binding = config.get('binding', config.get('endpoint_env', config.get('attachment_env', 'local')))
        if not isinstance(self.provider_binding, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', self.provider_binding):
            raise ValueError('safe_browser_provider_binding_required')
        self.root = Path(root).absolute()
        self.project_root = Path(project_root or Path.cwd()).absolute()
        self.acquire_seconds = _seconds(config.get("acquire_seconds", 15), 3600)
        self.session_seconds = _seconds(config.get("session_seconds", 300), 86400)
        self.cleanup_seconds = _seconds(config.get("cleanup_seconds", 3), 60)
        self.local = BrowserManager(self.root)
        self.sessions = {}
        self.process = None
        self.selector = None
        self._rpc_lock = threading.RLock()
        self._next_id = 0
        self._buffer = b""
        self._closed = False
        self.last_cleanup = None

    @classmethod
    def from_file(cls, filename, *, root, project_root=None):
        filename = Path(filename).absolute()
        # A shared provider config is not a shared project identity. Callers
        # running outside the project directory supply its root explicitly.
        return cls(root, configuration=json.loads(filename.read_text()), project_root=project_root)

    def _start_worker(self, deadline):
        if self.process is not None:
            return
        self.project_id = _project_identity(self.project_root, deadline)
        self.run_id = str(uuid.uuid4())
        self.evidence = _private_directory(self.root / self.run_id)
        self.socket_root = Path(tempfile.mkdtemp(prefix="treadway-ipc-"))
        stderr_path = self.evidence / "worker-stderr.log"
        descriptor = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stderr:
            self.process = subprocess.Popen(["node", str(Path(__file__).with_name("browser") / "browser-worker.js")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self._rpc(configuration={"root": str(self.evidence), "socketRoot": str(self.socket_root),
            "projectId": self.project_id, "runId": self.run_id, "acquireMs": max(1, int(self.acquire_seconds * 1000)),
            "sessionMs": max(1, int(self.session_seconds * 1000)), "cleanupMs": max(1, int(self.cleanup_seconds * 1000))},
            timeout=max(.001, min(5, deadline - time.monotonic())))

    def _rpc(self, *, timeout=None, **request):
        with self._rpc_lock:
            self._next_id += 1
            identifier = self._next_id
            try:
                self.process.stdin.write(json.dumps({"id": identifier, **request}).encode() + b"\n")
                self.process.stdin.flush()
                deadline = time.monotonic() + (timeout or self.acquire_seconds + self.cleanup_seconds + 2)
                while True:
                    while b"\n" in self._buffer:
                        raw, self._buffer = self._buffer.split(b"\n", 1)
                        result = json.loads(raw)
                        if result.get("id") != identifier:
                            raise BrowserRuntimeIncomplete("remote_control_reply_differs", evidence=self.evidence)
                        if "error" in result:
                            error = result["error"]
                            raise BrowserRuntimeIncomplete(error.get("code", "remote_control_incomplete"), evidence=self.evidence,
                                details={key: value for key, value in error.items() if key in {"phase", "status", "allocation", "cleanup"}})
                        return result["result"]
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not self.selector.select(remaining):
                        raise BrowserRuntimeIncomplete("remote_control_deadline", evidence=self.evidence)
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk or len(self._buffer) + len(chunk) > 16 * 1024 * 1024:
                        raise BrowserRuntimeIncomplete("remote_control_incomplete", evidence=self.evidence)
                    self._buffer += chunk
            except BrowserRuntimeIncomplete:
                raise
            except Exception:
                raise BrowserRuntimeIncomplete("remote_control_incomplete", evidence=self.evidence) from None

    def acquire(self, actor, *, deadline=None, _identity_lease=None, **local_options):
        if self._closed:
            raise BrowserRuntimeIncomplete("browser_runtime_closed")
        if self.configuration.get('mode') == 'borrowed':
            raise ValueError('remote_explicit_borrow_required')
        if not isinstance(actor, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", actor):
            raise ValueError("path_safe_session_name_required")
        if any(session.name == actor for session in self.sessions.values()):
            raise BrowserRuntimeIncomplete('browser_actor_already_acquired')
        if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
            raise ValueError("finite_monotonic_deadline_required")
        deadline = min(deadline, time.monotonic() + self.acquire_seconds) if deadline is not None else time.monotonic() + self.acquire_seconds
        if deadline <= time.monotonic():
            raise BrowserRuntimeIncomplete("remote_acquisition_deadline")
        if self.provider == "local":
            local_options.setdefault('require_new', True)
            local_options["startup_seconds"] = min(local_options.get("startup_seconds", 15), max(.001, deadline - time.monotonic()))
            local = self.local.start(actor, **local_options)
            session = RuntimeSession(actor, "local", local.generation, local.connection(), _local=local)
        else:
            if local_options:
                raise ValueError("local_launch_options_not_remote_capabilities")
            # Resolve only at this explicit live boundary, using existing provider rules.
            try:
                provider = EnvironmentProvider()
                endpoint = provider.read(CredentialRef("env", self.configuration["endpoint_env"]))
                headers = json.loads(provider.read(CredentialRef("env", self.configuration["headers_env"]))) if self.configuration.get("headers_env") else {}
            except Exception:
                raise BrowserRuntimeIncomplete("remote_credentials_unavailable") from None
            with self._rpc_lock:
                try:
                    self._start_worker(deadline)
                except BaseException:
                    # Startup can fail after the process exists. Preserve the
                    # first error and retained journal, but stop our own child.
                    try:
                        self.close()
                    except Exception:
                        pass
                    raise
                if _identity_lease is not None:
                    _identity_lease.record_run(directory=self.evidence, project_id=self.project_id,
                                               run_id=self.run_id, actor=actor)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrowserRuntimeIncomplete("remote_acquisition_deadline", evidence=self.evidence)
                result = self._rpc(operation="acquire", arguments={"actor": actor, "endpoint": endpoint, "headers": headers,
                    "budgetMs": max(1, min(int(self.acquire_seconds * 1000), int(remaining * 1000)))},
                    timeout=remaining + self.cleanup_seconds + 1)
            connection = result["connection"]
            session = RuntimeSession(actor, "browserless", connection["generation"], connection, capabilities=result["capabilities"])
        self.sessions[session.generation] = session
        return session

    def acquire_many(self, actors, **local_options):
        """One acquisition budget; roll back this call's acknowledged allocations."""
        names = list(actors)
        if not names or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", name) for name in names) or len(names) != len(set(names)):
            raise ValueError("distinct_actor_names_required")
        sessions = []
        deadline = time.monotonic() + self.acquire_seconds
        try:
            for name in names:
                sessions.append(self.acquire(name, deadline=deadline, **local_options))
            return sessions
        except BaseException:
            self.last_partial_cleanup = []
            for session in reversed(sessions):
                try:
                    self.last_partial_cleanup.append(self.release(session))
                except Exception:
                    self.last_partial_cleanup.append({"complete": False})
            raise

    def _owned(self, session):
        if not isinstance(session, RuntimeSession) or self.sessions.get(session.generation) is not session:
            raise BrowserRuntimeIncomplete("browser_runtime_binding_differs")
        return session

    def borrow(self, actor, identity, *, permission='observe', principal=None):
        """Attach the operator's exact existing context/page, without owning it.

        The attachment environment value is private JSON: version, endpoint,
        contextId, targetId, scope='context' and permission='observe' or 'drive'.
        All cooperating users must share the identity root on one host.
        """
        if self._closed:
            raise BrowserRuntimeIncomplete('browser_runtime_closed')
        if self.provider != 'browserless' or self.configuration.get('mode') != 'borrowed':
            raise ValueError('explicit_borrowed_browser_configuration_required')
        if not isinstance(actor, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', actor):
            raise ValueError('path_safe_session_name_required')
        if any(session.name == actor for session in self.sessions.values()):
            raise BrowserRuntimeIncomplete('browser_actor_already_acquired')
        if not isinstance(identity, BrowserIdentity) or identity.provider_binding != self.provider_binding:
            raise ValueError('browser_identity_provider_binding_differs')
        if permission not in {'observe', 'drive'}:
            raise ValueError('explicit_borrowed_browser_permission_required')
        if principal is not None:
            principal = json.loads(json.dumps(principal, allow_nan=False))
            if (not isinstance(principal, dict) or principal.get('origin') not in identity.origins
                    or not isinstance(principal.get('probe'), str) or not isinstance(principal.get('expected'), dict)
                    or not principal['expected']):
                raise ValueError('browser_identity_principal_binding_required')
        deadline = time.monotonic() + self.acquire_seconds
        try:
            provider = EnvironmentProvider()
            raw = provider.read(CredentialRef('env', self.configuration['attachment_env']))
            if len(raw) > 32768:
                raise ValueError()
            binding = json.loads(raw)
            if (not isinstance(binding, dict) or set(binding) != {'version', 'endpoint', 'contextId', 'targetId', 'scope', 'permission'}
                    or type(binding['version']) is not int or binding['version'] != 1 or binding['scope'] != 'context'
                    or binding['permission'] not in {'observe', 'drive'} or permission == 'drive' and binding['permission'] != 'drive'
                    or any(not isinstance(binding[key], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', binding[key])
                           for key in ('contextId', 'targetId'))):
                raise ValueError()
            endpoint = binding['endpoint']
            if not isinstance(endpoint, str) or not re.fullmatch(r'[!-~]+', endpoint):
                raise ValueError()
            url = urlsplit(endpoint)
            if (url.scheme not in {'http', 'https', 'ws', 'wss'} or not url.hostname or url.username or url.password
                    or '#' in endpoint or url.port is not None and not 0 < url.port <= 65535):
                raise ValueError()
            headers = json.loads(provider.read(CredentialRef('env', self.configuration['headers_env']))) if self.configuration.get('headers_env') else {}
        except Exception:
            raise BrowserRuntimeIncomplete('remote_borrowed_binding_invalid') from None
        canonical = BrowserIdentity(identity.root, 'treadway.borrowed-context.v1:' + binding['contextId'],
            identity.application, identity.identity_ref, identity.provider_binding, identity.origins, identity.components)
        if identity.resource == canonical.resource:
            raise ValueError('distinct_browser_identity_resource_required')
        project_id = _project_identity(self.project_root, deadline)
        self.project_id = project_id
        leases, attempted, session = [], False, None
        try:
            leases.append(identity.acquire(project_id))
            leases.append(canonical.acquire(project_id))
            with self._rpc_lock:
                try:
                    self._start_worker(deadline)
                except BaseException:
                    try:
                        self.close()
                    except Exception:
                        pass
                    raise
                for lease in leases:
                    lease.record_run(directory=self.evidence, project_id=project_id, run_id=self.run_id, actor=actor, mode='borrowed')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrowserRuntimeIncomplete('remote_acquisition_deadline', evidence=self.evidence)
                attempted = True
                result = self._rpc(operation='acquire', arguments={'actor': actor, 'endpoint': endpoint, 'headers': headers,
                    'mode': 'borrowed', 'borrowed': {'contextId': binding['contextId'], 'targetId': binding['targetId'],
                    'scope': 'context', 'permission': permission}, 'budgetMs': max(1, int(remaining * 1000))},
                    timeout=remaining + self.cleanup_seconds + 1)
            connection = result['connection']
            session = RuntimeSession(actor, 'browserless', connection['generation'], connection,
                capabilities=result['capabilities'], _identity_lease=leases[0], _context_lease=leases[1],
                _identity_principal=principal)
            self.sessions[session.generation] = session
            for lease in leases:
                lease.record_generation(session.generation)
            return session
        except BaseException as error:
            if session is not None:
                session._identity_failed = True
                try:
                    self.release(session)
                except Exception:
                    pass
            else:
                cleanup = error.details.get('cleanup', {}) if isinstance(error, BrowserRuntimeIncomplete) else {}
                clean = (not attempted or cleanup.get('ownership') == 'borrowed' and cleanup.get('attachmentDetached') is True
                         and cleanup.get('uncertainDispatches') is False)
                for lease in reversed(leases):
                    try:
                        lease.release(context_disposed=not attempted, attachment_detached=clean, uncertain=not clean)
                    except Exception:
                        pass
            raise

    def acquire_identity(self, actor, identity, *, principal, restore=True, landing_url=None,
                         state_timeout_seconds=10, **local_options):
        """Lease a saved identity for this whole browser lifetime.

        ``restore=False`` explicitly starts fresh for initial login/setup.
        Missing state is never repaired by an implicit login or account fallback.
        The actual principal is verified inside restore/export, independently of
        the configured identity label.
        """
        if self._closed:
            raise BrowserRuntimeIncomplete('browser_runtime_closed')
        if not isinstance(identity, BrowserIdentity) or identity.provider_binding != self.provider_binding:
            raise ValueError('browser_identity_provider_binding_differs')
        if not isinstance(actor, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', actor):
            raise ValueError('path_safe_session_name_required')
        if any(session.name == actor for session in self.sessions.values()):
            raise BrowserRuntimeIncomplete('browser_actor_already_acquired')
        if self.provider == 'browserless' and local_options:
            raise ValueError('local_launch_options_not_remote_capabilities')
        if type(restore) is not bool or local_options.get('persistent'):
            raise ValueError('browser_identity_fresh_context_required')
        state_timeout_seconds = _seconds(state_timeout_seconds, 30)
        principal = json.loads(json.dumps(principal, allow_nan=False))
        if (not isinstance(principal, dict) or principal.get('origin') not in identity.origins
                or set(principal) - {'origin', 'probe', 'expected', 'maxBodyBytes'}
                or not isinstance(principal.get('probe'), str) or not principal['probe'].startswith('/')
                or principal['probe'].startswith('//') or not isinstance(principal.get('expected'), dict)
                or not principal['expected']):
            raise ValueError('browser_identity_principal_binding_required')
        project_id = _project_identity(self.project_root, time.monotonic() + self.acquire_seconds)
        self.project_id = project_id
        lease = identity.acquire(project_id)
        session, browser_attempted = None, False
        try:
            snapshot = lease.read() if restore else None
            browser_attempted = True
            session = self.acquire(actor, _identity_lease=lease, **local_options)
            session._identity_lease, session._identity_principal = lease, principal
            if self.provider == 'browserless':
                lease.record_generation(session.generation)
            if restore:
                self._state_operation(session, 'restore', snapshot=snapshot,
                    landingUrl=landing_url or principal['origin'] + '/', timeout_seconds=state_timeout_seconds)
            return session
        except BaseException:
            if session is not None:
                session._identity_failed = True
                try:
                    self.release(session)
                except Exception:
                    pass
            else:
                try:
                    if self.provider == 'browserless' and lease._record.get('execution') is None:
                        browser_attempted = False  # The durable intent precedes every allocation RPC.
                    lease.release(context_disposed=not browser_attempted, uncertain=browser_attempted)
                except Exception:
                    pass  # Preserve the first failure; the manifest remains unavailable.
            raise

    def _state_operation(self, session, operation, *, timeout_seconds=10, **arguments):
        self._owned(session)
        if session._identity_lease is None:
            raise ValueError('browser_identity_lease_required')
        if session._identity_principal is None or session.capabilities.get('observationOnly'):
            raise ValueError('browser_identity_principal_binding_required')
        timeout_seconds = _seconds(timeout_seconds, 30)
        evidence_root = _private_directory(self.root / 'state-attempts')
        evidence = evidence_root / (str(uuid.uuid4()) + '.json')
        try:
            with self.drive(session):
                payload = {'operation': operation, 'connection': session.connection(),
                    'binding': session._identity_lease.binding, 'actor': session.name, 'generation': session.generation,
                    'principal': session._identity_principal, 'timeoutMs': max(1, int(timeout_seconds * 1000)), **arguments}
                transport = run_json_process(['node', str(Path(__file__).with_name('browser') / 'state-snapshot.js')],
                    input_data=json.dumps(payload), timeout_seconds=timeout_seconds + 3, preserve_newlines=True)
            private_json(evidence, transport)
            value = transport.get('payload')
            if (transport.get('failure') is not None or transport.get('exitCode') != 0
                    or not isinstance(value, dict) or value.get('complete') is not True):
                code = value.get('code') if isinstance(value, dict) else None
                code = code if isinstance(code, str) and re.fullmatch(r'(?:browser_|multi_origin_)[a-z_]+', code) else 'browser_state_operation_incomplete'
                raise BrowserRuntimeIncomplete(code, evidence=evidence)
            return value['result']
        except BaseException:
            session._identity_failed = True
            raise

    def save_identity(self, session, *, timeout_seconds=10):
        """Explicitly verify the actual principal, export and persist scoped state."""
        snapshot = self._state_operation(session, 'capture', timeout_seconds=timeout_seconds)
        try:
            return session._identity_lease.save(snapshot)
        except BaseException:
            session._identity_failed = True
            raise

    @contextmanager
    def drive(self, session):
        self._owned(session)
        if session._identity_lease is not None:
            session._identity_lease._current()
        if session._context_lease is not None:
            session._context_lease._current()
        if session.provider == "local":
            try:
                with self.local.drive(session._local):
                    yield session
            except BaseException:
                if session._identity_lease is not None:
                    session._identity_failed = True
                raise
            return
        lease = self._rpc(operation="reserve", connection=session.connection())
        session._connection.update(lease)
        failed = False
        try:
            yield session
        except BaseException:
            failed = True
            if session._identity_lease is not None:
                session._identity_failed = True
            raise
        finally:
            try:
                self.last_lease = self._rpc(operation="unreserve", connection=session.connection())
            except BrowserRuntimeIncomplete:
                if not failed:
                    raise
            finally:
                session._connection.pop("driveLease", None)

    def release(self, session):
        self._owned(session)
        try:
            if session.provider == "local":
                self.local.stop(session._local)
                result = {"complete": True}
            else:
                result = self._rpc(operation="release", connection=session.connection(), timeout=self.cleanup_seconds + 2)
        except BaseException:
            self.last_cleanup = {'complete': False, 'contextDisposed': False}
            if session._identity_lease is not None:
                try:
                    self.last_cleanup['identity'] = session._identity_lease.release()
                except Exception:
                    self.last_cleanup['identityRecoveryRequired'] = True
            if session._context_lease is not None:
                try:
                    self.last_cleanup['contextLease'] = session._context_lease.release()
                except Exception:
                    self.last_cleanup['contextRecoveryRequired'] = True
            raise
        self.last_cleanup = result
        failures = []
        for key, lease in [('identity', session._identity_lease), ('contextLease', session._context_lease)]:
            if lease is not None:
                try:
                    result[key] = lease.release(
                        context_disposed=result.get('contextDisposed', result.get('complete')) is True,
                        attachment_detached=result.get('attachmentDetached') is True,
                        uncertain=session._identity_failed or result.get('uncertainDispatches', False))
                except BaseException as error:
                    result[key] = {'released': False, 'recoveryRequired': True}
                    result['complete'] = False
                    failures.append(error)
        if failures:
            raise failures[0]
        return result

    def inspect(self, session):
        """Observe worker receipts; this neither sends CDP nor resolves an effect."""
        self._owned(session)
        if session.provider != 'browserless':
            raise ValueError('remote_receipt_inspection_required')
        return self._rpc(operation='inspect', connection=session.connection())

    def record_reconciliation(self, session, *, request_ref, outcome, evidence):
        """Retain an application's independent observation of one unknown effect.

        This does not prove remote execution stopped and never unlocks or replays
        the quarantined generation. The caller's application observer establishes
        the outcome; Treadway binds and retains its private evidence.
        """
        self._owned(session)
        if session.provider != 'browserless' or outcome not in {'applied', 'not_applied', 'unknown'}:
            raise ValueError('remote_reconciliation_evidence_required')
        source = Path(evidence)
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            import stat
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_size > 16 * 1024 * 1024:
                raise ValueError('private_bounded_reconciliation_evidence_required')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                data = stream.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError('private_bounded_reconciliation_evidence_required')
        finally:
            os.close(descriptor)
        reference = str(uuid.uuid4())
        directory = _private_directory(self.evidence / 'reconciliations')
        output = os.open(directory / reference, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(output, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return self._rpc(operation='reconcile', connection=session.connection(), arguments={
            'requestRef': request_ref, 'outcome': outcome,
            'evidence': {'reference': reference, 'sha256': hashlib.sha256(data).hexdigest()}})

    def close(self):
        if self._closed:
            return self.last_cleanup
        self._closed = True
        results = []
        try:
            for session in self.sessions.values():
                if session._identity_lease is not None:
                    try:
                        results.append(self.release(session))
                    except Exception:
                        results.append({'complete': False, 'identityRecoveryRequired': True})
            if self.process is not None:
                try:
                    results.append(self._rpc(operation="shutdown", timeout=self.cleanup_seconds + 2))
                except BrowserRuntimeIncomplete:
                    results.append({"complete": False, "remoteTermination": "unconfirmed"})
                try:
                    self.process.stdin.close()
                except OSError:
                    results.append({'complete': False, 'code': 'remote_owner_pipe_close_incomplete'})
                try:
                    self.process.wait(timeout=self.cleanup_seconds + 1)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=2)
                    results.append({"complete": False, "remoteTermination": "unconfirmed"})
            else:
                for session in self.sessions.values():
                    if session._identity_lease is None:
                        try:
                            results.append(self.release(session))
                        except Exception:
                            results.append({'complete': False, 'code': 'local_browser_cleanup_incomplete'})
        finally:
            if self.selector:
                self.selector.close()
            if self.process:
                self.process.stdout.close()
            if hasattr(self, "socket_root"):
                shutil.rmtree(self.socket_root, ignore_errors=True)
        self.last_cleanup = {"complete": all(result.get("complete") for result in results), "resources": results}
        return self.last_cleanup

    def __enter__(self):
        return self

    def __exit__(self, *error):
        try:
            self.close()
        except Exception:
            self.last_cleanup = {"complete": False}
            if error[0] is None:
                raise
