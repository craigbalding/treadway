"""Private, explicitly scoped browser state and cooperative same-host ownership.

Construction is passive. A free file lock is not proof that a former remote
browser stopped: an abandoned manifest stays recovery-required.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit
import uuid

from .browsers import private_json


MAX_STATE_BYTES = 8 * 1024 * 1024
COMPONENTS = frozenset({'cookies', 'localStorage', 'sessionStorage'})


class BrowserStateIncomplete(RuntimeError):
    """A code-only failure; credential state never belongs in exception text."""


def _text(value):
    if not isinstance(value, str) or not 0 < len(value) <= 1024 or any(ord(c) < 32 for c in value):
        raise ValueError('explicit_browser_identity_binding_required')
    return value


def _origin(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if parsed.scheme not in {'http', 'https'} or not host or parsed.username or parsed.password:
            raise ValueError()
        authority = '[' + host + ']' if ':' in host else host
        if parsed.port is not None and parsed.port != (443 if parsed.scheme == 'https' else 80):
            authority += ':' + str(parsed.port)
        if value != parsed.scheme + '://' + authority:
            raise ValueError()
        return value
    except (TypeError, ValueError):
        raise ValueError('canonical_application_origin_required') from None


def _directory(path):
    path = Path(path).absolute()
    if any(part.is_symlink() for part in (*path.parents, path)):
        raise BrowserStateIncomplete('private_browser_identity_directory_required')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = path.stat()
    if metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
        raise BrowserStateIncomplete('private_browser_identity_directory_required')
    return path


def _read(path, limit=MAX_STATE_BYTES):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
                or metadata.st_nlink != 1 or metadata.st_uid != os.getuid() or metadata.st_size > limit):
            raise BrowserStateIncomplete('private_bounded_browser_state_required')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise BrowserStateIncomplete('private_bounded_browser_state_required')
        return data
    finally:
        os.close(descriptor)


def _write(path, value):
    # Reject non-finite values and oversized state before replacing any file.
    raw = json.dumps(value, allow_nan=False, ensure_ascii=True).encode()
    if len(raw) > MAX_STATE_BYTES:
        raise BrowserStateIncomplete('bounded_browser_state_required')
    private_json(path, value)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@dataclass(frozen=True)
class BrowserIdentity:
    """An operator-assigned state resource, not proof of an application's user.

    All writers of the same resource must use the same trusted state root on
    one host. Copies, independent roots and multi-host writers need external
    coordination. Cross-project resource aliases are refused.
    """
    root: Path
    resource: str = field(repr=False)
    application: str
    identity_ref: str
    provider_binding: str
    origins: tuple[str, ...]
    components: tuple[str, ...] = ('cookies',)

    def __post_init__(self):
        for value in (self.resource, self.application, self.identity_ref, self.provider_binding):
            _text(value)
        origins = tuple(sorted(_origin(value) for value in self.origins))
        components = tuple(sorted(self.components))
        if not origins or len(origins) > 8 or len(set(origins)) != len(origins):
            raise ValueError('distinct_application_origins_required')
        if not components or len(set(components)) != len(components) or not set(components) <= COMPONENTS:
            raise ValueError('browser_state_component_unsupported')
        if len(origins) != 1 and set(components) - {'cookies'}:
            raise ValueError('multi_origin_web_storage_unsupported')
        object.__setattr__(self, 'root', Path(self.root).absolute())
        object.__setattr__(self, 'origins', origins)
        object.__setattr__(self, 'components', components)

    def binding(self, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', project_id):
            raise ValueError('explicit_project_identity_required')
        return {'projectId': project_id, 'application': self.application, 'identityRef': self.identity_ref,
                'providerBinding': self.provider_binding, 'origins': list(self.origins), 'components': list(self.components)}

    def acquire(self, project_id):
        """Acquire once, before restore/login/drive. Never steal an old owner."""
        binding = self.binding(project_id)
        root = _directory(self.root)
        directory = _directory(root / hashlib.sha256(self.resource.encode()).hexdigest())
        descriptor = os.open(directory / 'writer.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            metadata = os.fstat(descriptor)
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_nlink != 1
                    or metadata.st_uid != os.getuid()):
                raise BrowserStateIncomplete('private_browser_identity_lock_required')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BrowserStateIncomplete('browser_identity_in_use') from None
            manifest = directory / 'identity.json'
            if manifest.exists() or manifest.is_symlink():
                try:
                    record = json.loads(_read(manifest, 65536))
                except (OSError, ValueError):
                    raise BrowserStateIncomplete('browser_identity_manifest_incomplete') from None
                if record.get('version') != 'treadway.browser-identity/1' or record.get('binding') != binding:
                    raise BrowserStateIncomplete('browser_identity_binding_differs')
                if record.get('state') != 'released':
                    raise BrowserStateIncomplete('browser_identity_recovery_required')
            else:
                record = {'version': 'treadway.browser-identity/1', 'binding': binding, 'snapshot': None}
            record.update(state='leased', owner=str(uuid.uuid4()))
            _write(manifest, record)
            return IdentityLease(directory, descriptor, record)
        except BaseException:
            os.close(descriptor)
            raise

    def forget(self, project_id):
        """Delete this released resource's saved snapshots explicitly.

        This does not revoke credentials or remove retained run evidence. An
        active or abandoned browser owner still requires recovery first.
        """
        lease = self.acquire(project_id)
        try:
            for path in lease.directory.glob('state-*.json'):
                if not re.fullmatch(r'state-[0-9a-f-]{36}\.json', path.name):
                    continue
                _read(path)  # Refuse symlinks, shared aliases and non-private files.
                path.unlink()
            lease._record['snapshot'] = None
            _write(lease.directory / 'identity.json', lease._record)
            lease.release(context_disposed=True, uncertain=False)
            return {'forgotten': True, 'credentialRevocation': 'not_attempted', 'runEvidence': 'retained'}
        except BaseException:
            try:
                lease.release()
            except Exception:
                pass
            raise


class IdentityLease:
    """Live ownership held by BrowserRuntime; release only with cleanup evidence."""
    def __init__(self, directory, descriptor, record):
        self.directory, self._descriptor, self._record = directory, descriptor, record
        self._closed = False

    @property
    def binding(self):
        return json.loads(json.dumps(self._record['binding']))

    def _current(self):
        if self._closed:
            raise BrowserStateIncomplete('browser_identity_lease_closed')
        try:
            current = json.loads(_read(self.directory / 'identity.json', 65536))
        except (OSError, ValueError):
            raise BrowserStateIncomplete('browser_identity_manifest_incomplete') from None
        if current != self._record:
            raise BrowserStateIncomplete('browser_identity_owner_differs')

    def read(self):
        self._current()
        snapshot = self._record.get('snapshot')
        if snapshot is None:
            raise BrowserStateIncomplete('browser_identity_state_missing')
        if (not isinstance(snapshot, dict) or not isinstance(snapshot.get('file'), str)
                or not re.fullmatch(r'state-[0-9a-f-]{36}\.json', snapshot['file'])):
            raise BrowserStateIncomplete('browser_identity_snapshot_incomplete')
        raw = _read(self.directory / snapshot['file'])
        if hashlib.sha256(raw).hexdigest() != snapshot.get('sha256'):
            raise BrowserStateIncomplete('browser_identity_snapshot_differs')
        try:
            value = json.loads(raw)
        except ValueError:
            raise BrowserStateIncomplete('browser_identity_snapshot_incomplete') from None
        self._validate(value)
        return value

    def _validate(self, snapshot):
        if (not isinstance(snapshot, dict) or snapshot.get('version') != 'treadway.browser-state/1'
                or snapshot.get('binding') != self.binding or snapshot.get('complete') is not True
                or not isinstance(snapshot.get('sourceGeneration'), str) or not snapshot['sourceGeneration']):
            raise BrowserStateIncomplete('browser_identity_snapshot_binding_differs')

    def save(self, snapshot):
        self._current()
        self._validate(snapshot)
        target = self.directory / ('state-' + str(uuid.uuid4()) + '.json')
        _write(target, snapshot)
        self._record['snapshot'] = {'file': target.name, 'sha256': hashlib.sha256(_read(target)).hexdigest()}
        _write(self.directory / 'identity.json', self._record)
        return {'saved': True, 'components': self.binding['components'], 'sourceGeneration': snapshot['sourceGeneration']}

    def release(self, *, context_disposed=False, uncertain=True):
        if self._closed:
            return self.last_release
        try:
            self._current()
            self._record.update(state='released' if context_disposed is True and uncertain is False else 'recovery_required',
                                cleanup={'contextDisposed': context_disposed is True, 'uncertain': uncertain is not False})
            self._record.pop('owner', None)
            _write(self.directory / 'identity.json', self._record)
            self.last_release = {'released': True, 'recoveryRequired': self._record['state'] != 'released'}
            return self.last_release
        finally:
            self._closed = True
            os.close(self._descriptor)
