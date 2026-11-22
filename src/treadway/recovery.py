"""Opt-in authentication maintenance and durable execution of ONE HTTP mutation.

Native Robot/Python composition owns iteration. Applications own authentication,
response interpretation and effect reconciliation. This module never discovers
refresh endpoints, decodes token lifetimes, selects another actor or repairs input.
"""
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field, replace
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import uuid
from functools import wraps

from .sessions import HttpFailure, encode_body, validate_expected
from . import diagnostics as diag


def _trace_operation(function):
    @wraps(function)
    def execute(self, operation_id, *args, **kwargs):
        with diag.span('operation', level='INFO', operation_ref=diag.reference(operation_id)) as trace:
            try:
                result = function(self, operation_id, *args, **kwargs)
                trace.update(outcome=result['state'], cached=result.get('cached', False),
                             unresolved_effect=result['unresolved_effect'])
                return result
            except OperationIncomplete as error:
                code = error.receipt.get('code')
                trace.update(outcome=error.receipt['state'], unresolved_effect=error.receipt['unresolved_effect'],
                             reason=code if code in diag._ENUMS['reason'] else 'operation_incomplete')
                raise
    return execute


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _copy(value):
    return json.loads(_json(value))


class RecoveryError(RuntimeError):
    pass


class OperationIncomplete(RecoveryError):
    def __init__(self, receipt):
        self.receipt = receipt
        super().__init__("operation_incomplete; inspect exception.receipt and the private operation journal")


class _Store:
    """Small private atomic records, with nonblocking process-shared leases."""
    def __init__(self, root):
        self.root = Path(root).expanduser().absolute()

    def _directory(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise RecoveryError("private_recovery_directory_required")

    def _path(self, key, suffix):
        return self.root / (hashlib.sha256(key.encode()).hexdigest() + suffix)

    def _open(self, path, flags):
        fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            os.close(fd)
            raise RecoveryError("private_recovery_file_required")
        return fd

    @contextmanager
    def lease(self, key):
        self._directory()
        fd = self._open(self._path(key, '.lock'), os.O_RDWR | os.O_CREAT)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RecoveryError("recovery_scope_in_use") from None
            yield
        finally:
            os.close(fd)

    def read(self, key):
        try:
            fd = self._open(self._path(key, '.json'), os.O_RDONLY)
        except FileNotFoundError:
            return None
        with os.fdopen(fd) as handle:
            return json.load(handle)

    def write(self, key, record):
        data = _json(record).encode()
        fd, name = tempfile.mkstemp(prefix='.record-', dir=self.root)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, self._path(key, '.json'))
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)


@dataclass(frozen=True)
class RecoveryPolicy:
    """Enabling maintenance explicitly permits the configured owner's mechanisms.

    Verification is independent: disabling maintenance retains the probe. Only an
    explicit ``verify_principal=False`` suppresses it for an intentional test.
    SDK/provider callbacks must honor their supplied deadline. Use a bounded
    subprocess helper for untrusted/blocking callbacks requiring hard cancellation.
    """
    maintain_authentication: bool = False
    verify_principal: bool = True
    allow_interactive: bool = False
    max_renewals: int = 1
    max_dispatches: int = 2
    timeout_seconds: float = 30
    owner_timeout_seconds: float = 30

    def __post_init__(self):
        if (any(type(getattr(self, k)) is not bool for k in
                ('maintain_authentication', 'verify_principal', 'allow_interactive'))
                or type(self.max_renewals) is not int or not 0 <= self.max_renewals <= 10
                or type(self.max_dispatches) is not int or not 1 <= self.max_dispatches <= 20
                or not 0 < self.timeout_seconds <= 3600 or not 0 < self.owner_timeout_seconds <= 300):
            raise ValueError("bounded_explicit_recovery_policy_required")


@dataclass(frozen=True)
class AuthenticationResult:
    status: str  # ready / interaction_required / unavailable / rejected / unknown
    mechanism: str = "configured_owner"
    evidence: object = field(default=None, repr=False)

    def __post_init__(self):
        if self.status not in {'ready', 'interaction_required', 'unavailable', 'rejected', 'unknown'}:
            raise ValueError("explicit_authentication_result_required")


@dataclass(frozen=True)
class AuthenticationContext:
    actor: str
    origin: str
    session_id: str
    operation_id: str
    reason: str
    deadline: float  # monotonic; callbacks must enforce remaining budget themselves
    allow_interactive: bool
    observation: object = field(default=None, repr=False)
    previous: object = field(default=None, repr=False)  # original uncertain invocation for owner reconciliation


@dataclass(frozen=True)
class Assessment:
    """Application assertions, backed by retained response/effect evidence.

    An HTTP status is insufficient to establish a business effect. ``not_applied``
    must mean definitively rejected before effect, not an eventually-consistent
    empty read. ``idempotency_valid`` must cover this exact key/request/principal
    AND the application's current retention window.
    """
    outcome: str  # confirmed / rejected / unknown
    authentication_required: bool = False
    replay: str | None = None  # not_applied / idempotency_valid
    evidence: object = field(default=None, repr=False)
    replay_until: float | None = None  # UNIX time; required for idempotency retention

    def __post_init__(self):
        if (self.outcome not in {'confirmed', 'rejected', 'unknown'}
                or self.replay not in {None, 'not_applied', 'idempotency_valid'}
                or type(self.authentication_required) is not bool
                or self.replay == 'idempotency_valid' and
                (type(self.replay_until) not in (int, float) or not 0 < self.replay_until < float('inf'))
                or self.outcome == 'confirmed' and (self.replay or self.authentication_required)):
            raise ValueError("explicit_effect_assessment_required")


class AuthenticationOwner:
    """Application/SDK owns credentials; Treadway stores no token cache here.

    All cooperating consumers of a grant use the SAME private root and key. The
    owner lease spans preparation, probe, materialization and dispatch. Unrelated
    browser/SDK activity is outside this lock and must be coordinated by its owner.
    prepare/renew/reconcile(session, context) return AuthenticationResult. A lost
    potentially state-changing callback blocks further acquisition until owner's
    explicit reconcile resolves it. No refresh token is blindly replayed.

    classify(failure_or_response) returns True only for the binding's documented
    authentication-loss signal. It never receives a known wrong-principal failure.
    after_probe_headers(observation) may update only declared volatile headers
    (e.g. CSRF), never credentials establishing a different principal.
    """
    def __init__(self, key, root, *, prepare, renew=None, reconcile=None, classify=None,
                 after_probe_headers=None, volatile_headers=()):
        if not isinstance(key, str) or not key or not callable(prepare):
            raise ValueError("explicit_authentication_owner_required")
        self.key, self.store = key, _Store(root)
        self.prepare, self.renew, self.reconcile, self.classify = prepare, renew, reconcile, classify
        self.after_probe_headers = after_probe_headers
        self.volatile_headers = tuple(name.lower() for name in volatile_headers)
        if len(set(self.volatile_headers)) != len(self.volatile_headers):
            raise ValueError("unique_volatile_headers_required")

    @contextmanager
    def lease(self):
        with self.store.lease(self.key):
            yield

    def _call(self, callback, session, context, *, resolving=False):
        previous = self.store.read(self.key)
        if previous and previous['state'] in {'pending', 'unknown'} and not resolving:
            if self.reconcile is None:
                raise RecoveryError("authentication_outcome_unknown; owner reconciliation required")
            result = self._call(self.reconcile, session, replace(context, previous=_copy(previous)), resolving=True)
            if result.status != 'ready':
                raise RecoveryError("authentication_outcome_unresolved")
            previous = self.store.read(self.key)
        if time.monotonic() >= context.deadline:
            raise RecoveryError("authentication_deadline_exceeded; no callback started")
        if not resolving:
            diag.checkpoint()
        attempt_id = uuid.uuid4().hex
        record = {'state': 'pending', 'operation_id': context.operation_id,
                  'reason': context.reason, 'started': time.time(), 'attempt_id': attempt_id,
                  'previous_attempt_id': (previous or {}).get('attempt_id')}

        def retain():
            # Archive each callback independently, then atomically update its head.
            # Lost-refresh evidence survives subsequent reconciliation/preparation.
            self.store.write(self.key + ':' + attempt_id, record)
            self.store.write(self.key, record)

        retain()
        try:
            with diag.span('authentication', level='INFO' if resolving or context.reason == 'authentication_required' else 'DEBUG',
                           phase='reconcile' if resolving else
                           'renew' if context.reason == 'authentication_required' else 'prepare') as trace:
                result = callback(session, context)
                if isinstance(result, AuthenticationResult):
                    trace.update(outcome=result.status)
            if not isinstance(result, AuthenticationResult):
                raise TypeError('authentication_result_required')
            if time.monotonic() > context.deadline:
                result = AuthenticationResult('unknown', evidence={'code': 'owner_deadline_exceeded'})
            record.update(state=result.status, mechanism=result.mechanism, evidence=result.evidence)
            retain()
        except Exception as error:
            record.update(state='unknown', error_type=type(error).__name__)
            retain()
            raise RecoveryError("authentication_outcome_unknown; inspect owner journal") from None
        return result


class OperationExecutor:
    """Execute one immutable binding, with explicit bounded recovery and receipts.

    assess(operation, observation_or_failure, session) observes business effects.
    reconcile(operation, previous_record, session) is read-only and returns an
    Assessment; unknown/reserved work never dispatches without its permission.
    prerequisite(operation) runs after principal verification, before the internal
    durable reservation. It must not reenter this already-leased HttpSession;
    use an independent read-only observer for a resource revision check.
    """
    def __init__(self, session, journal_root, *, probe, expected, assess, owner=None,
                 reconcile=None, prerequisite=None, policy=None):
        validate_expected(expected)
        session._url(probe)
        if not callable(assess):
            raise ValueError("application_effect_observer_required")
        self.session, self.store, self.probe = session, _Store(journal_root), probe
        self.expected, self.assess = _copy(expected), assess
        self.owner, self.reconcile, self.prerequisite = owner, reconcile, prerequisite
        self.policy = policy or RecoveryPolicy()
        if self.policy.maintain_authentication and owner is None:
            raise ValueError("authentication_maintenance_requires_owner")

    def _observation(self, observed):
        failure = observed if isinstance(observed, HttpFailure) else None
        response = failure.observation if failure else observed
        return {'phase': failure.phase if failure else 'mutation',
                'dispatch': failure.dispatch if failure else 'possibly_started',
                'principal': failure.principal if failure else None,
                'code': failure.code if failure else None,
                'error_type': failure.error_type if failure else None,
                'flow_change': getattr(failure, 'flow_change', None),
                'http': None if response is None else {
                    'status': response.status, 'complete': response.complete,
                    'session_id': response.session_id,
                    'headers': list(response.headers), 'body_base64': base64.b64encode(response.body).decode()}}

    def read_evidence(self, operation_id):
        """Explicit private raw evidence access. Never log or return this via Robot.

        Normal execute results/exceptions contain only safe status and a private
        evidence path. This opt-in operation includes response cookies and bodies.
        """
        return self.store.read(operation_id)

    @_trace_operation
    def reconcile_only(self, operation_id):
        """Observe a retained effect without preparation, renewal or dispatch.

        Useful after implementation drift or interruption. Application observers
        must be read-only; this scope also rejects non-GET HttpSession requests.
        """
        with self.store.lease(operation_id):
            record = self.store.read(operation_id)
            if record is None:
                raise RecoveryError('recorded_operation_required')
            if record['state'] in {'confirmed', 'rejected'}:
                return self._summary(record, cached=True)
            with self.owner.lease() if self.owner else nullcontext():
                with self.session.observation_only():
                    self._reconcile(record)
            if record['state'] not in {'confirmed', 'rejected'}:
                self._stop(record, 'unknown', 'application_effect_unknown')
            return self._summary(record)

    def _summary(self, record, *, cached=False):
        return {key: record[key] for key in ('version', 'state', 'dispatches', 'renewals', 'unresolved_effect')} | {
            'operation_id': record['intent']['operation_id'],
            'cached': cached,
            'code': record['state'] if record['state'] in {'confirmed', 'rejected'} else next(
                (event['code'] for event in reversed(record['history']) if event['kind'] == 'stopped'), record['state']),
            'evidence_path': str(self.store._path(record['intent']['operation_id'], '.json'))}

    def _event(self, record, kind, **values):
        record['history'].append({'kind': kind, 'at': time.time(), **values})
        self.store.write(record['intent']['operation_id'], record)

        if kind == 'dispatch_reserved':
            diag.emit('dispatch_reserved', level='DEBUG', dispatch='reserved')

    def _stop(self, record, state, code):
        if state == 'not_dispatched' and record.get('unresolved_effect'):
            state = 'unknown'
        record['state'] = state
        self._event(record, 'stopped', code=code)
        raise OperationIncomplete(self._summary(record))

    def _context(self, record, reason, observed=None):
        return AuthenticationContext(self.session.actor, self.session.origin, self.session.session_id,
            record['intent']['operation_id'], reason, time.monotonic()+self.policy.owner_timeout_seconds,
            self.policy.allow_interactive, observed)

    def _auth(self, record, reason, observed=None):
        if not self.policy.maintain_authentication:
            self._stop(record, 'not_dispatched' if not record['dispatches'] else record['state'],
                       'authentication_maintenance_disabled')
        renewing = reason == 'authentication_required'
        callback = self.owner.renew if renewing else self.owner.prepare
        if callback is None:
            self._stop(record, record['state'], 'authentication_mechanism_unavailable')
        if renewing:
            if record['renewals'] >= self.policy.max_renewals:
                self._stop(record, record['state'], 'renewal_budget_exhausted')
            record['renewals'] += 1
        self._event(record, 'authentication_started', reason=reason)
        try:
            result = self.owner._call(callback, self.session, self._context(record, reason, observed))
        except diag.FlowChanged:
            self._stop(record, record['state'], 'flow_changed_before_authentication')
        except RecoveryError:
            self._stop(record, record['state'], 'authentication_outcome_unknown')
        self._event(record, 'authentication_completed', reason=reason, status=result.status,
                    mechanism=result.mechanism, evidence=result.evidence)
        if result.status != 'ready':
            self._stop(record, record['state'], 'authentication_' + result.status)

    def _classify(self, observed):
        if (isinstance(observed, HttpFailure) and
                (observed.principal == 'wrong' or observed.phase != 'probe')):
            return False
        return bool(self.owner and self.owner.classify and self.owner.classify(observed) is True)

    def _assessment(self, record, result, *, reconciliation=False):
        if not isinstance(result, Assessment):
            raise TypeError('effect_assessment_required')
        if result.replay == 'idempotency_valid' and not record['intent']['idempotency_key']:
            raise ValueError('idempotency_permission_requires_stable_key')
        self._event(record, 'reconciliation' if reconciliation else 'assessment',
                    outcome=result.outcome, authentication_required=result.authentication_required,
                    replay=result.replay, evidence=result.evidence, replay_until=result.replay_until)
        if result.outcome == 'confirmed' or reconciliation and (result.outcome == 'rejected' or result.replay == 'not_applied'):
            record['unresolved_effect'] = False
        elif result.outcome == 'rejected' or result.replay == 'not_applied':
            record['unresolved_effect'] = record.get('prior_unresolved', False)
        record['replay_until'] = result.replay_until if result.replay == 'idempotency_valid' else None
        if result.outcome == 'confirmed':
            record['state'] = 'confirmed'
        elif result.replay:
            record['state'] = 'retry_permitted'
        elif result.outcome == 'rejected':
            record['state'] = 'unknown' if record['unresolved_effect'] else 'rejected'
        else:
            record['state'] = 'unknown'
        self.store.write(record['intent']['operation_id'], record)
        diag.emit('effect_assessed', outcome=result.outcome, permission=result.replay or 'none',
                  unresolved_effect=record['unresolved_effect'])
        return result

    def _reconcile(self, record):
        if self.reconcile is None:
            self._stop(record, 'unknown', 'application_effect_reconciliation_required')
        try:
            with diag.span('reconciliation', level='INFO'):
                result = self.reconcile(_copy(record['intent']), _copy(record), self.session)
            return self._assessment(record, result, reconciliation=True)
        except OperationIncomplete:
            raise
        except Exception:
            self._stop(record, 'unknown', 'application_reconciliation_incomplete')

    @_trace_operation
    def execute(self, operation_id, path, *, body, binding, method='POST', headers=None,
                idempotency_key=None, idempotency_header='Idempotency-Key'):
        """Native loops call this once per binding; reentry uses the same ID/intent.

        ``headers`` are immutable application semantics (If-Match, content type,
        etc.). Secret authorization/CSRF material belongs to the session/owner.
        The application declares which other header names are secret/volatile.
        """
        self.session._url(path)
        if not isinstance(operation_id, str) or not operation_id or method not in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            raise ValueError('explicit_stable_mutation_required')
        semantic = {key.lower(): value for key, value in (headers or {}).items()}
        if len(semantic) != len(headers or {}):
            raise ValueError('duplicate_semantic_header')
        volatile = self.owner.volatile_headers if self.owner else ()
        if set(semantic) & ({'authorization', 'cookie', 'proxy-authorization', 'host', 'content-length'} | set(volatile)):
            raise ValueError('credentials_must_not_enter_operation_intent')
        semantic.setdefault('content-type', 'application/json')
        if semantic['content-type'] != 'application/json':
            raise ValueError('json_operation_content_type_required')
        key_header = idempotency_header.lower()
        if idempotency_key is not None:
            if (not isinstance(idempotency_key, str) or not idempotency_key or key_header in semantic
                    or key_header in volatile or key_header in {
                        'authorization', 'cookie', 'proxy-authorization', 'host', 'content-type', 'content-length'}):
                raise ValueError('explicit_stable_idempotency_key_required')
            semantic[key_header] = idempotency_key
        intent = _copy({'operation_id': operation_id, 'actor': self.session.actor, 'origin': self.session.origin,
            'probe': self.probe, 'expected': self.expected, 'verify_principal': self.policy.verify_principal,
            'owner': None if self.owner is None else {'key': self.owner.key, 'root': str(self.owner.store.root)},
            'path': path, 'method': method, 'body': body, 'body_base64': base64.b64encode(encode_body(body) or b'').decode(),
            'binding': binding, 'headers': semantic, 'idempotency_key': idempotency_key,
            'volatile_headers': volatile})
        with self.store.lease(operation_id):
            record = self.store.read(operation_id)
            if record is not None and record['intent'] != intent:
                raise RecoveryError('recorded_operation_intent_differs; original binding retained')
            if record is None:
                record = {'version': 'treadway.operation/1', 'intent': intent, 'state': 'not_dispatched',
                          'dispatches': 0, 'renewals': 0, 'unresolved_effect': False, 'history': []}
                self._event(record, 'intent_recorded')
            if record['state'] in {'confirmed', 'rejected'}:
                return self._summary(record, cached=True)
            if self.owner is None:
                return self._execute_locked(record)
            with self.owner.lease():
                return self._execute_locked(record)

    def _execute_locked(self, record):
        if self.policy.maintain_authentication:
            self._auth(record, 'prepare')
        while True:
            if record['unresolved_effect']:
                result = self._reconcile(record)
                if record['state'] in {'confirmed', 'rejected'}:
                    return self._summary(record)
                if result.authentication_required:
                    self._auth(record, 'authentication_required')
                    continue
                if not result.replay:
                    self._stop(record, 'unknown', 'application_effect_unknown')
            if record['dispatches'] >= self.policy.max_dispatches:
                self._stop(record, record['state'], 'dispatch_budget_exhausted')
            intent = record['intent']

            def reserve():
                diag.checkpoint()
                if self.prerequisite:
                    self.prerequisite(_copy(intent))
                if (record.get('replay_until') is not None and
                        time.time() + self.policy.timeout_seconds >= record['replay_until']):
                    raise RecoveryError('idempotency_retention_window_insufficient')
                record['state'] = 'pending'
                record['prior_unresolved'] = record['unresolved_effect']
                record['unresolved_effect'] = True
                record['dispatches'] += 1
                self._event(record, 'dispatch_reserved')

            try:
                arguments = dict(method=intent['method'], body=_copy(intent['body']),
                                 headers=dict(intent['headers']), timeout_seconds=self.policy.timeout_seconds)
                if self.policy.verify_principal:
                    observed = self.session.attempt(intent['path'], probe=self.probe, expected=intent['expected'],
                        before_dispatch=reserve,
                        after_probe_headers=self.owner.after_probe_headers if self.owner else None,
                        volatile_headers=self.owner.volatile_headers if self.owner else (), **arguments)
                else:
                    reserve()
                    observed = self.session.request(intent['path'], phase='mutation', **arguments)
            except HttpFailure as error:
                observed = error
            except Exception as error:
                # Reservation may have reached disk before its acknowledgement.
                self._stop(record, 'unknown' if record['state'] == 'pending' else record['state'],
                           'operation_boundary_incomplete_' + type(error).__name__)
            self._event(record, 'observation', value=self._observation(observed))
            if isinstance(observed, HttpFailure) and observed.dispatch == 'not_started':
                record['state'] = 'unknown' if record['unresolved_effect'] else 'not_dispatched'
                try:
                    authentication_required = observed.phase == 'probe' and self._classify(observed)
                except Exception:
                    self._stop(record, 'not_dispatched', 'authentication_classification_incomplete')
                if authentication_required:
                    self._auth(record, 'authentication_required', observed)
                    continue
                self._stop(record, 'not_dispatched', observed.code)
            try:
                assessment = self._assessment(record, self.assess(_copy(intent), observed, self.session))
            except Exception:
                self._stop(record, 'unknown', 'application_effect_assessment_incomplete')
            if record['state'] == 'confirmed':
                return self._summary(record)
            if assessment.authentication_required:
                self._auth(record, 'authentication_required', observed)
                if record['state'] == 'rejected':
                    return self._summary(record)
                continue
            if record['state'] == 'rejected':
                return self._summary(record)
