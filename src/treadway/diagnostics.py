"""Opt-in, safe live diagnostics. Native Python/Robot composition owns the run.

No handlers, files, threads or application traffic are created on import or by a
constructor. Raw observations remain in the existing private evidence journals.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import ast
import hashlib
import hmac
import json
import logging
import math
import os
from pathlib import Path
import queue
import sys
import threading
import time
import uuid
from functools import wraps


_current = ContextVar('treadway_diagnostics', default=None)
_scope = ContextVar('treadway_diagnostic_scope', default={})
_reference_key = os.urandom(32)
LEVELS = {'DEBUG': 10, 'INFO': 20, 'WARNING': 30, 'ERROR': 40}
PHASES = {'request', 'probe', 'mutation', 'prepare', 'renew', 'reconcile', 'configuration',
          'browser_start', 'browser_attach', 'identity_configuration', 'flow_configuration',
          'flow', 'cleanup', 'account', 'credentials', 'prep', 'finish', 'authentication_state'}
OUTCOMES = {'completed', 'failed', 'interrupted', 'confirmed', 'rejected', 'unknown',
            'not_dispatched', 'ready', 'interaction_required', 'unavailable', 'pending',
            'verified', 'invalid', 'mismatch', 'expected', 'wrong', 'not_started', 'possibly_started', 'retry_permitted'}
EVENTS = {
    'run_started', 'run_finished', 'operation_started', 'operation_finished',
    'http_started', 'http_dispatched', 'http_finished', 'principal_probe_started',
    'principal_probe_finished', 'authentication_started', 'authentication_finished',
    'dispatch_reserved', 'effect_assessed', 'reconciliation_started', 'reconciliation_finished',
    'process_started', 'process_finished', 'process_stderr_seen', 'browser_started',
    'browser_finished', 'browser_screen', 'browser_action_started', 'browser_action_finished',
    'browser_wait_started', 'browser_wait_finished', 'cookie_export_started', 'cookie_export_finished',
    'cdp_started', 'cdp_finished', 'keyword_started', 'keyword_finished',
    'test_started', 'test_finished', 'implementation_changed', 'contract_mismatch',
    'diagnostic_sink_failed', 'bridge_invalid', 'source_incomplete',
    'bridge_started', 'bridge_finished',
    'principal_probe_started', 'principal_probe_finished',
}
_REFS = {'operation_ref', 'target_ref', 'contract_ref', 'expected_ref', 'observed_ref', 'source_ref', 'producer_ref'}
_BOOLS = {'complete', 'cached', 'material', 'unresolved_effect'}
_NUMBERS = {'duration_ms', 'http_status', 'dispatches', 'renewals', 'bytes', 'exit_code', 'remaining_ms', 'source_sequence'}
_ENUMS = {'phase': PHASES, 'outcome': OUTCOMES,
          'stage': {'app_host', 'email', 'picker', 'password', 'password_persist', 'totp', 'kmsi', 'locked',
                    'password_change', 'password_error', 'code_error', 'unknown', 'registration_secret',
                    'registration_other_app', 'registration_manual', 'registration_complete',
                    'registration_redirect', 'registration_install', 'registration_add_account',
                    'registration_qr', 'registration_intro'},
          'dispatch': {'not_started', 'possibly_started', 'reserved'},
          'principal': {'expected', 'wrong', 'unknown'},
          'method': {'GET', 'POST', 'PUT', 'PATCH', 'DELETE'},
          'permission': {'not_applied', 'idempotency_valid', 'none'},
          'error_kind': {'FlowChanged', 'HttpFailure', 'OperationIncomplete', 'TimeoutError',
                         'Interrupted', 'ValueError', 'RuntimeError', 'Other'},
          'reason': {'implementation_changed', 'contract_mismatch', 'source_unavailable', 'invalid_event',
                     'sink_failed', 'authentication_required', 'callback_unknown', 'none',
                     'operation_incomplete', 'actual_principal_differs', 'actual_principal_unknown',
                     'authentication_maintenance_disabled', 'renewal_budget_exhausted', 'dispatch_budget_exhausted',
                     'flow_changed_before_authentication', 'flow_changed_before_dispatch',
                     'application_effect_unknown', 'authentication_outcome_unknown'}}


def reference(value):
    """Opaque correlation reference; labels, URLs and identities never go to logs."""
    run = _current.get()
    return hmac.new(run._key if run else _reference_key, str(value).encode(), hashlib.sha256).hexdigest()[:24]


def _fields(values):
    result = {}
    for key, value in values.items():
        if value is None:
            continue
        if key in _REFS and isinstance(value, str) and len(value) == 24 and all(c in '0123456789abcdef' for c in value):
            result[key] = value
        elif key in _BOOLS and type(value) is bool:
            result[key] = value
        elif key in _NUMBERS and type(value) in (int, float) and math.isfinite(value):
            if (key == 'http_status' and (type(value) is not int or not 100 <= value <= 599)
                    or key == 'exit_code' and (type(value) is not int or not -255 <= value <= 255)
                    or key not in {'exit_code', 'http_status'} and not 0 <= value <= 10**12):
                raise ValueError('bounded_safe_diagnostic_number_required')
            result[key] = value
        elif key in _ENUMS and isinstance(value, str) and value in _ENUMS[key]:
            result[key] = value
        else:
            raise ValueError('unsupported_safe_diagnostic_field')
    return result


def _error(error):
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        return 'Interrupted'
    return type(error).__name__ if type(error).__name__ in _ENUMS['error_kind'] else 'Other'


def _message(event):
    parts = [event['event']]
    for key in ('operation_ref', 'phase', 'stage', 'method', 'http_status', 'outcome',
                'principal', 'dispatch', 'reason', 'target_ref', 'duration_ms'):
        if key in event:
            parts.append(f'{key}={event[key]}')
    return ' '.join(parts)


class ConsoleSink:
    def __init__(self, stream=None, level='INFO'):
        self.stream, self.level = stream, LEVELS[level]

    def __call__(self, event):
        if LEVELS[event['level']] >= self.level:
            print(_message(event), file=self.stream or sys.stderr, flush=True)


class LoggingSink:
    """Uses standard logging configuration; never adds root/global handlers."""
    def __call__(self, event):
        logger = logging.getLogger('treadway.events')
        if logger.hasHandlers():
            logger.log(LEVELS[event['level']], _message(event), extra={'treadway_event': event})


class RobotSink:
    def __init__(self, *, console=False, level='INFO'):
        self.console, self.level = console, LEVELS[level]
        self.pending = queue.Queue(maxsize=1024)

    def __call__(self, event):
        from robot.api import logger
        if LEVELS[event['level']] >= self.level:
            self.pending.put_nowait(event)
            if self.console:
                logger.console(_message(event), stream='stderr')

    def flush(self):
        """Robot records library messages on its execution thread, at boundaries."""
        from robot.api import logger
        while not self.pending.empty():
            event = self.pending.get_nowait()
            logger.write(json.dumps(event), level='WARN' if event['level'] == 'WARNING' else event['level'])


class FlowChanged(RuntimeError):
    """A material definition/contract mismatch; raw values are not in the error."""
    def __init__(self, report):
        self.report = report
        super().__init__('flow_changed; dependent action stopped; inspect exception.report and retained evidence')


class RunDiagnostics:
    """One explicit run, with safe events, statistics and definition checkpoints.

    ``watch`` names the application's flow/adapter files. Runtime modules are
    watched only with ``watch_runtime=True``. Checkpoints detect edits since entry; they do not claim
    that an unobserved external application changed. Sinks must be bounded.
    """
    def __init__(self, output=None, *, console=False, level='INFO', sinks=(), watch=(), watch_runtime=False,
                 queue_size=1024, flush_seconds=1, max_sources=4096):
        if level not in LEVELS:
            raise ValueError('explicit_diagnostic_level_required')
        self.output, self.level, self.console = output, level, console
        self.sinks = list(sinks)
        self.watch, self.watch_runtime = tuple(Path(p) for p in watch), watch_runtime
        self.id = uuid.uuid4().hex
        self._key = os.urandom(32)
        self.directory = None
        self._file = None
        self._token = None
        self._scope_token = None
        self._started = None
        self._ended = None
        self._sequence = 0
        self._definitions = {}
        self._raw_definitions = {}
        self._invalidated = None
        self._counts, self._outcomes, self._timings = {}, {}, {}
        self._sink_errors = 0
        self._failed_sinks = set()
        if type(queue_size) is not int or not 1 <= queue_size <= 65536 or not 0 <= flush_seconds <= 5:
            raise ValueError('bounded_diagnostic_delivery_required')
        self._queue = queue.Queue(maxsize=queue_size)
        self._done = threading.Event()
        self._worker = None
        self._flush_seconds = flush_seconds
        self._dropped = 0
        self._sources = {}
        self._cached = 0
        self._run_outcome = 'pending'
        if type(max_sources) is not int or not 1 <= max_sources <= 65536:
            raise ValueError('bounded_diagnostic_sources_required')
        self._max_sources = max_sources
        self._auth_counts = {'prepare': 0, 'renew': 0, 'reconcile': 0}
        self._http_statuses = {}

    def __enter__(self):
        if self._started is not None:
            raise RuntimeError('diagnostic_run_already_started')
        paths = list(self.watch)
        if self.watch_runtime:
            package = Path(__file__).parent
            paths += list(package.glob('*.py')) + list((package/'browser').glob('*.js'))
        for path in paths:
            source = path.resolve()
            self._definitions[source] = (self._stat(source), self._digest(source))
            if None in self._definitions[source]:
                raise ValueError('readable_flow_definition_required')
            self._raw_definitions[source] = hashlib.sha256(source.read_bytes()).hexdigest()
        if self.output is not None:
            root = Path(self.output).expanduser()
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.directory = root / self.id
            self.directory.mkdir(mode=0o700)
            self._file = (self.directory/'events.jsonl').open('x', encoding='utf8')
            os.chmod(self.directory/'events.jsonl', 0o600)
            with (self.directory/'coverage.json').open('x', encoding='utf8') as coverage:
                os.chmod(self.directory/'coverage.json', 0o600)
                json.dump({'version': 'treadway.coverage/1', 'sources': [
                    {'path': str(path), 'fingerprint': digest,
                     'source_ref': hmac.new(self._key, str(path).encode(), hashlib.sha256).hexdigest()[:24]}
                    for path, (_, digest) in self._definitions.items()],
                    'limits': ['disk checkpoints are not loaded-code attestation',
                               'Python AST ignores comments/formatting; other files use content bytes',
                               'coverage does not eliminate all check-to-dispatch races']}, coverage)
        self._started = time.monotonic()
        self._token = _current.set(self)
        self._scope_token = _scope.set({})
        if self.console:
            self.sinks.append(ConsoleSink(level=self.level))
        self.sinks.append(LoggingSink())
        self._worker = threading.Thread(target=self._deliver, name='treadway-diagnostics', daemon=True)
        self._worker.start()
        self.emit('run_started')
        return self

    def __exit__(self, kind, error, traceback):
        try:
            self._run_outcome = 'completed' if error is None else 'interrupted' if isinstance(error, (KeyboardInterrupt, SystemExit)) else 'failed'
            for source in self._sources.values():
                if not source['complete']:
                    self.emit('source_incomplete', level='WARNING', outcome='unknown', reason='source_unavailable')
            self.emit('run_finished', outcome=self._run_outcome)
            self._ended = time.monotonic()
            self._done.set()
            self._worker.join(self._flush_seconds)
            if self.directory:
                try:
                    path = self.directory/'summary.json'
                    with path.open('x', encoding='utf8') as output:
                        os.chmod(path, 0o600)
                        json.dump(self.summary(), output, indent=2)
                except Exception:
                    self._sink_errors += 1
        finally:
            _current.reset(self._token)
            _scope.reset(self._scope_token)

    def _reference(self, value):
        return hmac.new(self._key, str(value).encode(), hashlib.sha256).hexdigest()[:24]

    @staticmethod
    def _stat(path):
        try:
            stat = path.stat()
            return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
        except OSError:
            return None

    @staticmethod
    def _digest(path):
        try:
            content = path.read_bytes()
            if path.suffix == '.py':
                try:
                    content = ast.dump(ast.parse(content), include_attributes=False).encode()
                except (SyntaxError, ValueError):
                    pass
            return hashlib.sha256(content).hexdigest()
        except (OSError, ValueError):
            return None

    def checkpoint(self):
        if self._invalidated:
            raise FlowChanged(self._invalidated)
        for path, (stat, digest) in self._definitions.items():
            current_stat = self._stat(path)
            if current_stat == stat:
                continue
            current_digest = self._digest(path)
            if current_digest == digest and current_stat is not None:
                self._definitions[path] = current_stat, digest
                self._raw_definitions[path] = hashlib.sha256(path.read_bytes()).hexdigest()
                continue
            report = {'source_ref': self._reference(path), 'expected_ref': self._reference(digest), 'observed_ref': self._reference(current_digest),
                      'reason': 'implementation_changed' if current_stat is not None else 'source_unavailable',
                      'material': True, 'dispatch': 'not_started'}
            self._invalidated = report
            if self.directory:
                try:
                    change = self.directory/('change-'+uuid.uuid4().hex+'.json')
                    with change.open('x', encoding='utf8') as output:
                        os.chmod(change, 0o600)
                        json.dump({'report': report, 'path': str(path), 'expected_fingerprint': digest,
                                   'observed_fingerprint': current_digest,
                                   'expected_stat': stat, 'observed_stat': current_stat}, output)
                except Exception:
                    self._sink_errors += 1
            self.emit('implementation_changed', level='ERROR', **report)
            raise FlowChanged(report)

    def check_contract(self, name, *, expected, observed, material=True):
        if expected == observed:
            return True
        report = {'contract_ref': self._reference(name), 'expected_ref': self._reference(json.dumps(expected, sort_keys=True)),
                  'observed_ref': self._reference(json.dumps(observed, sort_keys=True)), 'material': material,
                  'reason': 'contract_mismatch', 'dispatch': 'not_started'}
        self.emit('contract_mismatch', level='ERROR' if material else 'WARNING', **report)
        if self.directory:
            try:
                path = self.directory / ('contract-'+uuid.uuid4().hex+'.json')
                with path.open('x', encoding='utf8') as output:
                    os.chmod(path, 0o600)
                    json.dump({'report': report, 'expected': expected, 'observed': observed}, output)
            except Exception:
                self._sink_errors += 1
        if material:
            raise FlowChanged(report)
        return False

    def emit(self, event, *, level='INFO', **values):
        if event not in EVENTS or level not in LEVELS:
            raise ValueError('known_diagnostic_event_required')
        safe = _fields(values)
        scope = _scope.get() if current_run() is self else {}
        self._sequence += 1
        envelope = {'version': 'treadway.event/1', 'run_id': self.id, 'sequence': self._sequence,
                    'at': datetime.now(timezone.utc).isoformat(),
                    'elapsed_ms': round((time.monotonic()-self._started)*1000, 3),
                    'event': event, 'level': level, **scope, **safe}
        self._counts[event] = self._counts.get(event, 0)+1
        if event == 'operation_finished':
            outcome = safe.get('outcome', 'unknown')
            self._outcomes[outcome] = self._outcomes.get(outcome, 0)+1
            self._cached += int(safe.get('cached', False))
        if event == 'authentication_started' and safe.get('phase') in self._auth_counts:
            self._auth_counts[safe['phase']] += 1
        if event == 'http_finished' and 'http_status' in safe:
            status = str(safe['http_status'])
            self._http_statuses[status] = self._http_statuses.get(status, 0)+1
        if 'duration_ms' in safe:
            timing = self._timings.setdefault(event, {'count': 0, 'total_ms': 0, 'max_ms': 0})
            timing['count'] += 1
            timing['total_ms'] = round(timing['total_ms']+safe['duration_ms'], 3)
            timing['max_ms'] = max(timing['max_ms'], safe['duration_ms'])
        try:
            self._queue.put_nowait(envelope)
        except queue.Full:
            self._dropped += 1
        return envelope

    def _deliver(self):
        sinks = ([self._write] if self._file else []) + self.sinks
        try:
            while not self._done.is_set() or not self._queue.empty():
                try:
                    event = self._queue.get(timeout=.05)
                except queue.Empty:
                    continue
                try:
                    for index, sink in enumerate(sinks):
                        if index in self._failed_sinks:
                            continue
                        try:
                            sink(dict(event))
                        except Exception:
                            self._sink_errors += 1
                            self._failed_sinks.add(index)
                finally:
                    self._queue.task_done()
        finally:
            if self._file:
                try:
                    self._file.close()
                except Exception:
                    self._sink_errors += 1

    def _write(self, event):
        self._file.write(json.dumps(event)+'\n')
        self._file.flush()

    def summary(self):
        incomplete = (self._sink_errors or self._dropped or self._queue.unfinished_tasks or self._counts.get('bridge_invalid', 0)
                      or any(not value['complete'] for value in self._sources.values()))
        return {'version': 'treadway.run/1', 'run_id': self.id,
                'outcome': self._run_outcome,
                'duration_ms': 0 if self._started is None else round(((self._ended or time.monotonic())-self._started)*1000, 3),
                'events': dict(self._counts), 'operation_outcomes': dict(self._outcomes),
                'counts': {'operation_calls': self._counts.get('operation_started', 0),
                           'cached_returns': self._cached,
                           'http_handoffs': self._counts.get('http_dispatched', 0),
                           'dispatch_reservations': self._counts.get('dispatch_reserved', 0),
                           'principal_checks': self._counts.get('principal_probe_started', 0),
                           'authentication_preparations': self._auth_counts['prepare'],
                           'authentication_renewals': self._auth_counts['renew'],
                           'authentication_reconciliations': self._auth_counts['reconcile'],
                           'contract_mismatches': self._counts.get('contract_mismatch', 0)},
                'timings': {key: dict(value) for key, value in self._timings.items()},
                'http_statuses': dict(self._http_statuses),
                'diagnostic_errors': self._sink_errors, 'dropped_events': self._dropped,
                'pending_deliveries': self._queue.unfinished_tasks, 'telemetry_complete': not bool(incomplete),
                'implementation_changed': self._invalidated is not None,
                'limits': ['timings are nested and must not be summed as wall time',
                           'statistics describe observed work in this process, not server-side effects']}

    def bridge(self):
        if len(self._sources) >= self._max_sources:
            completed = next((key for key, value in self._sources.items() if value['complete']), None)
            if completed:
                del self._sources[completed]
            else:
                self._dropped += 1
                if self._definitions:
                    raise RuntimeError('guarded_diagnostic_source_capacity_exhausted')
                return None
        producer = uuid.uuid4().hex
        self._sources[producer] = {'sequence': 0, 'complete': False, 'finished': False}
        return {'run_id': self.id, 'producer_id': producer,
                'operation_ref': _scope.get().get('operation_ref') if current_run() is self else None, 'level': self.level,
                'guard_runtime': self.watch_runtime, 'guard_enabled': bool(self._definitions),
                'reference_key': self._key.hex(),
                'evidence_directory': str(self.directory) if self.directory else None,
                'guard_sources': [{'path': str(path), 'sha256': digest} for path, digest in self._raw_definitions.items()]}

    def accept_bridge(self, line):
        try:
            if len(line) > 8192:
                raise ValueError()
            value = json.loads(line)
            if not isinstance(value, dict) or 'treadway_event' not in value:
                self.emit('process_stderr_seen', level='DEBUG')
                return
            event = value['treadway_event']
            if (not isinstance(event, dict) or event.get('run_id') != self.id
                    or event.get('event') not in EVENTS or event.get('level') not in LEVELS
                    or event.get('producer_id') not in self._sources):
                raise ValueError()
            source = self._sources[event['producer_id']]
            if (type(event.get('sequence')) is not int or event['sequence'] != source['sequence']+1
                    or source['finished'] or source['sequence'] == 0 and event['event'] != 'bridge_started'):
                raise ValueError()
            if not isinstance(event.get('fields'), dict):
                raise ValueError()
            fields = _fields(event.get('fields', {}))
            if event['event'] == 'implementation_changed':
                if (fields.get('material') is not True or fields.get('dispatch') != 'not_started'
                        or fields.get('reason') not in {'implementation_changed', 'source_unavailable'}
                        or not all(key in fields for key in ('source_ref', 'expected_ref', 'observed_ref'))):
                    raise ValueError()
                self._invalidated = {key: value for key, value in fields.items()
                                     if key in {'source_ref', 'expected_ref', 'observed_ref', 'reason', 'material', 'dispatch'}}
            source['sequence'] = event['sequence']
            if event['event'] == 'bridge_finished':
                source['complete'] = fields.get('complete') is True
                source['finished'] = True
            self.emit(event['event'], level=event['level'], **{**fields,
                      'producer_ref': self._reference(event['producer_id']), 'source_sequence': event['sequence']})
        except Exception:
            self.emit('bridge_invalid', level='WARNING', reason='invalid_event')


def current_run():
    return _current.get()


def emit(event, *, level='INFO', **values):
    run = current_run()
    if run:
        try:
            return run.emit(event, level=level, **values)
        except Exception:
            run._sink_errors += 1


def checkpoint():
    run = current_run()
    if run:
        run.checkpoint()


@contextmanager
def span(kind, *, level='DEBUG', **values):
    run = current_run()
    result = {}
    if run is None:
        yield result
        return
    safe = _fields(values)
    parent = _scope.get()
    token = _scope.set({**parent, 'span_id': uuid.uuid4().hex,
                        **({'parent_span_id': parent['span_id']} if 'span_id' in parent else {}),
                        **({'operation_ref': safe['operation_ref']} if 'operation_ref' in safe else {})})
    started = time.monotonic()
    emit(kind+'_started', level=level, **safe)
    try:
        yield result
    except BaseException as error:
        result.setdefault('outcome', 'interrupted' if isinstance(error, (KeyboardInterrupt, SystemExit)) else 'failed')
        result['error_kind'] = _error(error)
        raise
    finally:
        try:
            emit(kind+'_finished', level='ERROR' if result.get('outcome') in {'failed', 'interrupted'} or 'error_kind' in result else level,
                 **{**safe, **result, 'duration_ms': round((time.monotonic()-started)*1000, 3)})
        finally:
            _scope.reset(token)


def bridge_configuration():
    return current_run().bridge() if current_run() else None


def forward_progress(line):
    if current_run():
        current_run().accept_bridge(line)


def traced(kind, *, level='DEBUG'):
    """Observe a mechanics boundary without inspecting arguments or result data."""
    def decorate(function):
        @wraps(function)
        def invoke(*args, **kwargs):
            with span(kind, level=level, target_ref=reference(function.__qualname__)):
                return function(*args, **kwargs)
        return invoke
    return decorate
