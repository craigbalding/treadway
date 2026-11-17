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
        return self._acquire(project_id)

    def _acquire(self, project_id, *, recovery=False):
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
                if not isinstance(record, dict) or record.get('version') != 'treadway.browser-identity/1' or record.get('binding') != binding:
                    raise BrowserStateIncomplete('browser_identity_binding_differs')
                if recovery and record.get('state') not in {'leased', 'recovery_required', 'recovering'}:
                    raise BrowserStateIncomplete('browser_identity_recovery_not_required')
                if not recovery and record.get('state') != 'released':
                    raise BrowserStateIncomplete('browser_identity_recovery_required')
                proof = record.get('lastRecovery')
                if proof is not None:
                    try:
                        valid = (isinstance(proof, dict) and isinstance(proof.get('file'), str)
                            and re.fullmatch(r'recovery-[0-9a-f-]{36}\.json', proof['file'])
                            and hashlib.sha256(_read(directory / proof['file'])).hexdigest() == proof.get('sha256'))
                    except OSError:
                        valid = False
                    if not valid:
                        raise BrowserStateIncomplete('browser_identity_recovery_evidence_differs')
            else:
                if recovery:
                    raise BrowserStateIncomplete('browser_identity_manifest_missing')
                record = {'version': 'treadway.browser-identity/1', 'binding': binding, 'snapshot': None}
            if not recovery:
                record.pop('execution', None)
            record.update(state='recovering' if recovery else 'leased', owner=str(uuid.uuid4()))
            _write(manifest, record)
            return IdentityLease(directory, descriptor, record)
        except BaseException:
            os.close(descriptor)
            raise

    def recover(self, project_id, *, run_id, actor, generation):
        """Re-enable a saved snapshot after evidence-bound, scoped cleanup.

        Reads only the previously recorded Browserless run. It never contacts a
        provider, kills a process, steals a live lease or resumes an old target.
        Unconfirmed cleanup and unresolved effects still require their owners.
        """
        if any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value)
               for value in (run_id, actor, generation)):
            raise ValueError('explicit_browser_run_binding_required')
        lease = self._acquire(project_id, recovery=True)
        try:
            execution = lease._record.get('execution')
            if (not isinstance(execution, dict) or execution.get('provider') != 'browserless'
                    or execution.get('mode') != 'snapshot-fresh' or execution.get('projectId') != project_id
                    or execution.get('runId') != run_id or execution.get('actor') != actor
                    or not isinstance(execution.get('directory'), str) or not Path(execution['directory']).is_absolute()
                    or execution.get('generation', generation) != generation):
                raise BrowserStateIncomplete('browser_identity_recovery_binding_differs')
            from .browser_receipts import inspect_browser_run
            observed = inspect_browser_run(execution['directory'], project_id=project_id, run_id=run_id)
            matches = [item for item in observed['actors'] if item['actor'] == actor and item['generation'] == generation]
            if not observed['journalComplete'] or len(matches) != 1:
                raise BrowserStateIncomplete('browser_identity_run_evidence_incomplete')
            previous, = matches
            if previous['mode'] != 'fresh' or previous['cleanup'] is None or previous['cleanup']['contextDisposed'] is not True:
                raise BrowserStateIncomplete('browser_identity_remote_fence_required')
            if previous['unresolvedEffects']:
                raise BrowserStateIncomplete('browser_identity_effect_reconciliation_required')
            proof = {'version': 'treadway.browser-identity-recovery/1', 'binding': lease.binding,
                'execution': execution, 'generation': generation, 'journalSha256': observed['journalSha256'],
                'cleanup': previous['cleanup'], 'reconciliations': [item for item in previous['commands'] if item['outcome'] == 'unknown']}
            path = lease.directory / ('recovery-' + str(uuid.uuid4()) + '.json')
            _write(path, proof)
            lease._record['lastRecovery'] = {'file': path.name, 'sha256': hashlib.sha256(_read(path)).hexdigest()}
            _write(lease.directory / 'identity.json', lease._record)
            lease.release(context_disposed=True, uncertain=False)
            return {'recovered': True, 'previousGeneration': generation, 'previousGenerationResumed': False}
        except BaseException:
            try:
                lease.release()
            except Exception:
                pass
            raise

    def forget(self, project_id):
        """Delete this released resource's saved snapshots explicitly.

        This does not revoke credentials or remove retained run evidence. An
        active or abandoned browser owner still requires recovery first.
        """
        lease = self.acquire(project_id)
        try:
            lease.require_storage_kind('snapshot')
            for path in lease.directory.glob('state-*.json'):
                if not re.fullmatch(r'state-[0-9a-f-]{36}\.json', path.name):
                    continue
                _read(path)  # Refuse symlinks, shared aliases and non-private files.
                path.unlink()
            lease._record['snapshot'] = None
            _write(lease.directory / 'identity.json', lease._record)
            lease.release(context_disposed=True, uncertain=False)
            return {'forgotten': True, 'credentialRevocation': 'not_attempted', 'runEvidence': 'retained'}
        except BaseException as error:
            try:
                if isinstance(error, BrowserStateIncomplete) and str(error) == 'browser_identity_storage_kind_differs':
                    lease.release(profile_released=True, uncertain=False)
                else:
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

    def require_storage_kind(self, kind, *, initialize=False):
        self._current()
        current = self._record.get('storageKind', 'snapshot')
        if current == kind:
            return
        if (initialize and kind == 'provider-session' and 'storageKind' not in self._record
                and self._record.get('snapshot') is None and self._record.get('execution') is None):
            self._record['storageKind'] = kind
            _write(self.directory / 'identity.json', self._record)
            return
        raise BrowserStateIncomplete('browser_identity_storage_kind_differs')

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
        self.require_storage_kind('snapshot')
        self._current()
        snapshot = self._record.get('snapshot')
        if snapshot is None:
            raise BrowserStateIncomplete('browser_identity_state_missing')
        if (not isinstance(snapshot, dict) or not isinstance(snapshot.get('file'), str)
                or not re.fullmatch(r'state-[0-9a-f-]{36}\.json', snapshot['file'])):
            raise BrowserStateIncomplete('browser_identity_snapshot_incomplete')
        try:
            raw = _read(self.directory / snapshot['file'])
        except OSError:
            raise BrowserStateIncomplete('browser_identity_snapshot_incomplete') from None
        if hashlib.sha256(raw).hexdigest() != snapshot.get('sha256'):
            raise BrowserStateIncomplete('browser_identity_snapshot_differs')
        try:
            value = json.loads(raw)
        except ValueError:
            raise BrowserStateIncomplete('browser_identity_snapshot_incomplete') from None
        self._validate(value)
        return value

    def record_run(self, *, directory, project_id, run_id, actor, mode='snapshot-fresh'):
        """Durably bind this owner before the worker's allocation request."""
        self._current()
        if (mode not in {'snapshot-fresh', 'borrowed', 'provider-session'} or project_id != self.binding['projectId'] or any(not isinstance(value, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) for value in (run_id, actor))):
            raise ValueError('explicit_browser_run_binding_required')
        self.require_storage_kind('provider-session' if mode == 'provider-session' else 'snapshot')
        self._record['execution'] = {'provider': 'browserless', 'mode': mode,
            'directory': str(Path(directory).absolute()), 'projectId': project_id, 'runId': run_id, 'actor': actor}
        _write(self.directory / 'identity.json', self._record)

    def record_generation(self, generation):
        self._current()
        if not isinstance(generation, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', generation):
            raise ValueError('explicit_browser_generation_required')
        self._record['execution']['generation'] = generation
        _write(self.directory / 'identity.json', self._record)

    def _validate(self, snapshot):
        if (not isinstance(snapshot, dict) or snapshot.get('version') != 'treadway.browser-state/1'
                or snapshot.get('binding') != self.binding or snapshot.get('complete') is not True
                or not isinstance(snapshot.get('sourceGeneration'), str) or not snapshot['sourceGeneration']):
            raise BrowserStateIncomplete('browser_identity_snapshot_binding_differs')

    def save(self, snapshot):
        self.require_storage_kind('snapshot')
        self._current()
        self._validate(snapshot)
        target = self.directory / ('state-' + str(uuid.uuid4()) + '.json')
        _write(target, snapshot)
        self._record['snapshot'] = {'file': target.name, 'sha256': hashlib.sha256(_read(target)).hexdigest()}
        _write(self.directory / 'identity.json', self._record)
        return {'saved': True, 'components': self.binding['components'], 'sourceGeneration': snapshot['sourceGeneration']}

    def release(self, *, context_disposed=False, attachment_detached=False, profile_released=False, uncertain=True):
        if self._closed:
            return self.last_release
        self.last_release = {'released': False, 'recoveryRequired': True}
        try:
            self._current()
            execution = self._record.get('execution')
            borrowed = isinstance(execution, dict) and execution.get('mode') == 'borrowed'
            provider_profile = self._record.get('storageKind') == 'provider-session'
            finished = profile_released is True if provider_profile else attachment_detached is True if borrowed else context_disposed is True
            self._record.update(state='released' if finished and uncertain is False else 'recovery_required',
                                cleanup={'contextDisposed': context_disposed is True,
                                         'attachmentDetached': attachment_detached is True, 'uncertain': uncertain is not False})
            if provider_profile:
                self._record['cleanup']['profileReleased'] = profile_released is True
            self._record.pop('owner', None)
            _write(self.directory / 'identity.json', self._record)
            self.last_release = {'released': True, 'recoveryRequired': self._record['state'] != 'released'}
            return self.last_release
        finally:
            self._closed = True
            os.close(self._descriptor)
