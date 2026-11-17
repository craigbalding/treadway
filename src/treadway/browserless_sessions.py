"""Explicit Browserless Session API lifecycle; provider credentials stay private.

The Session API's isolated per-session profile is a separate capability from an
arbitrary CDP URL. Use the existing HTTP deadline/redirect machinery and identity
writer leases. No discovery, implicit creation, owner takeover or HTTP retry.
"""
from __future__ import annotations

import base64
import hashlib
from http.cookiejar import CookieJar
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlsplit
from urllib.request import Request
import uuid

from .browser_state import BrowserIdentity, BrowserStateIncomplete, _read, _write
from .credentials import CredentialRef, EnvironmentProvider
from .sessions import deadline_client


class ProviderSessionIncomplete(RuntimeError):
    def __init__(self, code, *, outcome='unknown', evidence=None, status=None):
        self.code, self.outcome, self.evidence, self.status = code, outcome, evidence, status
        super().__init__(code)


def origin(value, *, websocket=False):
    try:
        if not isinstance(value, str) or len(value) > 32768 or not re.fullmatch(r'[!-~]+', value):
            raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme not in ({'ws', 'wss'} if websocket else {'http', 'https'}) or not parsed.hostname
                or parsed.username or parsed.password or '#' in value):
            raise ValueError()
        scheme = {'ws': 'http', 'wss': 'https'}.get(parsed.scheme, parsed.scheme)
        host = parsed.hostname
        authority = '[' + host + ']' if ':' in host else host
        if parsed.port is not None and parsed.port != (443 if scheme == 'https' else 80):
            authority += ':' + str(parsed.port)
        return scheme + '://' + authority
    except (TypeError, ValueError):
        raise ValueError('browserless_session_endpoint_invalid') from None


def configuration(config):
    """Validate public policy without resolving an endpoint or making files."""
    values = config.get('session_allowed_origins', [])
    if not isinstance(values, list) or len(values) > 8:
        raise ValueError('browserless_session_authority_policy_invalid')
    for value in values:
        if origin(value) != value:
            raise ValueError('browserless_session_authority_policy_invalid')
    if len(set(values)) != len(values):
        raise ValueError('browserless_session_authority_policy_invalid')


def _headers(runtime):
    try:
        provider = EnvironmentProvider()
        headers = json.loads(provider.read(CredentialRef('env', runtime.configuration['headers_env']))) if runtime.configuration.get('headers_env') else {}
        if (not isinstance(headers, dict) or any(not isinstance(k, str) or not re.fullmatch(r'[!#$%&\'*+.^_`|~0-9A-Za-z-]+', k)
                or k.lower() in {'host', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization', 'cookie'}
                or not isinstance(v, str) or any(c in v for c in '\r\n\0') for k, v in headers.items())
                or len({k.lower() for k in headers}) != len(headers)
                or len(json.dumps(headers)) > 32768):
            raise ValueError()
        return headers
    except Exception:
        raise ProviderSessionIncomplete('browserless_session_credentials_unavailable', outcome='not_dispatched') from None


def _credentials(runtime):
    try:
        url = EnvironmentProvider().read(CredentialRef('env', runtime.configuration['session_api_env']))
        origin(url)
    except Exception:
        raise ProviderSessionIncomplete('browserless_session_credentials_unavailable', outcome='not_dispatched') from None
    return url, _headers(runtime)


def _http(url, method, *, body=None, headers=None, deadline, directory):
    """One request, bounded private facts, environment proxies/CAs, no redirects."""
    origin(url)
    reference = 'provider-http-' + str(uuid.uuid4()) + '.json'
    path = directory / reference
    record = {'version': 'treadway.browserless-http/1', 'method': method, 'url': url,
              'requestHeaders': headers or {}, 'requestBody': body, 'outcome': 'unknown'}
    _write(path, record)  # Record intent before urllib may dispatch anything.
    status, response, data = None, None, bytearray()
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProviderSessionIncomplete('browserless_session_deadline', outcome='not_dispatched', evidence=reference)
        payload = None if body is None else json.dumps(body, allow_nan=False).encode()
        request = Request(url, data=payload, headers={**(headers or {}), **({'Content-Type': 'application/json'} if body is not None else {})}, method=method)
        try:
            response = deadline_client(CookieJar(), deadline).open(request, timeout=remaining)
        except HTTPError as error:
            response = error
        status = response.status
        record.update(status=status, responseHeaders=list(response.headers.items()))
        _write(path, record)
        while len(data) <= 65536:
            chunk = getattr(response, 'read1', response.read)(min(32768, 65537 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        body_complete = len(data) <= 65536 and getattr(response, 'length', 0) in {None, 0}
        record.update(responseBodyBase64=base64.b64encode(data[:65536]).decode(), complete=body_complete)
        if len(data) > 65536:
            raise ProviderSessionIncomplete('browserless_session_response_limit', evidence=reference, status=status)
        if not body_complete:
            raise ProviderSessionIncomplete('browserless_session_response_body_incomplete', evidence=reference, status=status)
        record['outcome'] = 'replied'
        _write(path, record)
        return status, bytes(data), {'file': reference, 'sha256': hashlib.sha256(_read(path)).hexdigest()}
    except ProviderSessionIncomplete as error:
        record['outcome'] = error.outcome
        _write(path, record)
        raise
    except Exception:
        record.update(responseBodyBase64=base64.b64encode(data[:65536]).decode(), complete=False)
        _write(path, record)
        raise ProviderSessionIncomplete('browserless_session_http_incomplete', evidence=reference, status=status) from None
    finally:
        if response is not None:
            response.close()


def canonical_identity(identity, session_id):
    return BrowserIdentity(identity.root, 'treadway.browserless-session.v1:' + session_id,
        identity.application, identity.identity_ref, identity.provider_binding, identity.origins, identity.components)


def read_capability(lease):
    lease.require_storage_kind('provider-session')
    item = lease._record.get('providerSession')
    if not isinstance(item, dict) or not isinstance(item.get('file'), str) or not re.fullmatch(r'provider-session-[0-9a-f-]{36}\.json', item['file']):
        raise BrowserStateIncomplete('browserless_session_missing')
    path = lease.directory / item['file']
    try:
        raw = _read(path, 262144)
    except OSError:
        raise BrowserStateIncomplete('browserless_session_capability_incomplete') from None
    if hashlib.sha256(raw).hexdigest() != item.get('sha256'):
        raise BrowserStateIncomplete('browserless_session_capability_differs')
    try:
        value = json.loads(raw)
        if (value['version'] != 'treadway.browserless-session/1' or value['binding'] != lease.binding
                or value['scope'] != 'isolated-provider-profile' or value['state'] != 'created'
                or not isinstance(value['session']['id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', value['session']['id'])):
            raise ValueError()
        origin(value['session']['connect'], websocket=True)
        origin(value['session']['stop'])
        creation = value['creation']
        if (not isinstance(creation, dict) or not isinstance(creation.get('file'), str)
                or not re.fullmatch(r'provider-http-[0-9a-f-]{36}\.json', creation['file'])
                or hashlib.sha256(_read(lease.directory / creation['file'])).hexdigest() != creation.get('sha256')):
            raise ValueError()
        return value, path, item['sha256']
    except (KeyError, TypeError, ValueError, OSError):
        raise BrowserStateIncomplete('browserless_session_capability_incomplete') from None


def create(runtime, identity, *, ttl_seconds, headless=True):
    from .browser_runtime import _seconds, _project_identity
    _check(runtime, identity)
    if type(headless) is not bool:
        raise ValueError('explicit_browserless_headless_choice_required')
    ttl = max(1, int(_seconds(ttl_seconds, 90 * 86400) * 1000))
    deadline = time.monotonic() + runtime.acquire_seconds
    url, headers = _credentials(runtime)
    project_id = _project_identity(runtime.project_root, deadline)
    runtime.project_id = project_id
    lease = identity.acquire(project_id)
    clean, canonical = True, None
    try:
        lease.require_storage_kind('provider-session', initialize=True)
        if lease._record.get('providerSession') is not None:
            raise BrowserStateIncomplete('browserless_session_already_exists')
        clean = False
        status, data, evidence = _http(url, 'POST', body={'ttl': ttl, 'processKeepAlive': 0, 'headless': headless, 'browser': 'chromium'},
            headers=headers, deadline=deadline, directory=lease.directory)
        if not 200 <= status < 300:
            clean = status in {400, 401, 403, 404, 407, 429}
            raise ProviderSessionIncomplete('browserless_session_creation_rejected' if clean else 'browserless_session_creation_incomplete',
                outcome='rejected' if clean else 'unknown', evidence=evidence['file'], status=status)
        try:
            response = json.loads(data)
            if (not isinstance(response, dict) or not isinstance(response.get('id'), str)
                    or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', response['id']) or type(response.get('ttl')) is not int or response['ttl'] != ttl):
                raise ValueError()
            allowed = {origin(url), *runtime.configuration.get('session_allowed_origins', [])}
            if origin(response['connect'], websocket=True) not in allowed or origin(response['stop']) not in allowed:
                raise ValueError()
            if origin(url).startswith('https:') and (not response['connect'].startswith('wss:') or not response['stop'].startswith('https:')):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise ProviderSessionIncomplete('browserless_session_response_contract_incomplete', evidence=evidence['file']) from None
        capability = {'version': 'treadway.browserless-session/1', 'binding': lease.binding, 'scope': 'isolated-provider-profile',
            'state': 'created', 'session': response, 'creation': evidence, 'apiOrigin': origin(url)}
        path = lease.directory / ('provider-session-' + str(uuid.uuid4()) + '.json')
        _write(path, capability)
        lease._record['providerSession'] = {'file': path.name, 'sha256': hashlib.sha256(_read(path)).hexdigest()}
        lease._record['providerInitialized'] = False
        lease._record.pop('providerPrincipalBinding', None)
        lease._record.pop('lastProviderVerification', None)
        lease._record.pop('providerFence', None)
        _write(lease.directory / 'identity.json', lease._record)
        canonical = canonical_identity(identity, response['id']).acquire(project_id)
        canonical.require_storage_kind('provider-session', initialize=True)
        clean = True
        return {'created': True, 'scope': 'isolated-provider-profile', 'ttlMs': ttl, 'reference': path.name}
    except ProviderSessionIncomplete as error:
        if error.outcome == 'not_dispatched':
            clean = True
        raise
    finally:
        if canonical is not None:
            canonical.release(profile_released=clean, uncertain=not clean)
        lease.release(profile_released=clean, context_disposed=clean, uncertain=not clean)


def _check(runtime, identity):
    if runtime._closed or runtime.provider != 'browserless' or runtime.configuration.get('mode') != 'provider-session':
        raise ValueError('explicit_provider_session_configuration_required')
    if not isinstance(identity, BrowserIdentity) or identity.provider_binding != runtime.provider_binding:
        raise ValueError('browser_identity_provider_binding_differs')


def acquire(runtime, actor, identity, *, principal, initial_setup=False, landing_url=None, verify_seconds=10):
    from .browser_runtime import RuntimeSession, BrowserRuntimeIncomplete, _project_identity, _seconds
    _check(runtime, identity)
    if not isinstance(actor, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', actor):
        raise ValueError('path_safe_session_name_required')
    if any(item.name == actor for item in runtime.sessions.values()):
        raise BrowserStateIncomplete('browser_actor_already_acquired')
    if type(initial_setup) is not bool:
        raise ValueError('explicit_provider_initial_setup_required')
    _seconds(verify_seconds, 30)
    principal = json.loads(json.dumps(principal, allow_nan=False))
    if (not isinstance(principal, dict) or principal.get('origin') not in identity.origins
            or set(principal) - {'origin', 'probe', 'expected', 'maxBodyBytes'} or not isinstance(principal.get('probe'), str)
            or not principal['probe'].startswith('/') or principal['probe'].startswith('//')
            or not isinstance(principal.get('expected'), dict) or not principal['expected']):
        raise ValueError('browser_identity_principal_binding_required')
    if landing_url is not None and origin(landing_url) != principal['origin']:
        raise ValueError('browser_state_landing_origin_differs')
    deadline = time.monotonic() + runtime.acquire_seconds
    project_id = _project_identity(runtime.project_root, deadline)
    runtime.project_id = project_id
    lease = identity.acquire(project_id)
    canonical, attempted, session = None, False, None
    try:
        capability, path, digest = read_capability(lease)
        initialized = lease._record.get('providerInitialized') is True
        if initial_setup and initialized or not initial_setup and not initialized:
            raise BrowserStateIncomplete('browserless_session_initial_setup_refused' if initial_setup else 'browserless_session_initial_setup_required')
        if lease._record.get('providerPrincipalBinding', principal) != principal:
            raise BrowserStateIncomplete('browser_identity_principal_binding_differs')
        canonical = canonical_identity(identity, capability['session']['id']).acquire(project_id)
        canonical.require_storage_kind('provider-session')
        headers = _headers(runtime)
        if origin(capability['session']['connect'], websocket=True) != capability['apiOrigin']:
            headers = {}
        with runtime._rpc_lock:
            runtime._start_worker(deadline)
            for item in (lease, canonical):
                item.record_run(directory=runtime.evidence, project_id=project_id, run_id=runtime.run_id, actor=actor, mode='provider-session')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BrowserRuntimeIncomplete('remote_acquisition_deadline', evidence=runtime.evidence)
            attempted = True
            result = runtime._rpc(operation='acquire', arguments={'actor': actor, 'endpoint': capability['session']['connect'],
                'headers': headers, 'mode': 'provider-session', 'profile': {'file': str(path), 'sha256': digest},
                'budgetMs': max(1, int(remaining * 1000))}, timeout=remaining + runtime.cleanup_seconds + 1)
        connection = result['connection']
        session = RuntimeSession(actor, 'browserless', connection['generation'], connection, capabilities=result['capabilities'],
            _identity_lease=lease, _context_lease=canonical, _identity_principal=principal)
        runtime.sessions[session.generation] = session
        for item in (lease, canonical):
            item.record_generation(session.generation)
        if not initial_setup:
            _verify(runtime, session, landing_url=landing_url or principal['origin'] + '/', timeout_seconds=verify_seconds)
        return session
    except BaseException as error:
        if session is not None:
            session._identity_failed = True
            try:
                runtime.release(session)
            except Exception:
                pass
        else:
            cleanup = error.details.get('cleanup', {}) if isinstance(error, BrowserRuntimeIncomplete) else {}
            clean = not attempted or cleanup.get('profileReleased') is True and cleanup.get('uncertainDispatches') is False
            for item in (canonical, lease):
                if item is not None:
                    try:
                        item.release(profile_released=clean, context_disposed=not attempted, uncertain=not clean)
                    except Exception:
                        pass
        raise


def _verify(runtime, session, *, landing_url=None, timeout_seconds=10):
    lease = session._identity_lease
    lease.require_storage_kind('provider-session')
    result = runtime._state_operation(session, 'verify', timeout_seconds=timeout_seconds,
        **({'landingUrl': landing_url} if landing_url is not None else {}))
    reference = 'provider-principal-' + str(uuid.uuid4()) + '.json'
    path = lease.directory / reference
    _write(path, result)
    lease._record.update(providerInitialized=True, providerPrincipalBinding=session._identity_principal,
        lastProviderVerification={'file': reference, 'sha256': hashlib.sha256(_read(path)).hexdigest()})
    _write(lease.directory / 'identity.json', lease._record)
    return {'verified': True, 'generation': session.generation, 'evidence': reference}


def verify(runtime, session, *, timeout_seconds=10):
    runtime._owned(session)
    if session._identity_lease is None or session._identity_lease._record.get('storageKind') != 'provider-session':
        raise ValueError('explicit_provider_identity_required')
    return _verify(runtime, session, timeout_seconds=timeout_seconds)


def _prior_binding(previous_run):
    if (not isinstance(previous_run, dict) or set(previous_run) != {'run_id', 'actor', 'generation'}
            or any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', value)
                   for value in previous_run.values())):
        raise ValueError('explicit_previous_provider_run_binding_required')
    return dict(previous_run)


def _prior_execution(lease, project_id, previous_run):
    execution = lease._record.get('execution')
    if (not isinstance(execution, dict) or execution.get('provider') != 'browserless'
            or execution.get('mode') != 'provider-session' or execution.get('projectId') != project_id
            or execution.get('runId') != previous_run['run_id'] or execution.get('actor') != previous_run['actor']
            or execution.get('generation') != previous_run['generation']
            or not isinstance(execution.get('directory'), str) or not Path(execution['directory']).is_absolute()):
        raise BrowserStateIncomplete('browserless_session_previous_run_differs')
    return execution


def _force_url(url):
    values = [value for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=True) if key == 'force']
    if values:
        if values != ['true']:
            raise BrowserStateIncomplete('browserless_session_force_parameter_conflicts')
        return url
    return url + ('&' if '?' in url else '?') + 'force=true'


def _effects(execution, previous_run):
    from .browser_receipts import inspect_browser_run
    observed = inspect_browser_run(execution['directory'], project_id=execution['projectId'], run_id=execution['runId'])
    actors = [item for item in observed['actors'] if item['actor'] == previous_run['actor']
              and item['generation'] == previous_run['generation'] and item['mode'] == 'provider-session']
    if not observed['journalComplete'] or len(actors) != 1:
        raise BrowserStateIncomplete('browserless_session_run_evidence_incomplete')
    return observed, actors[0]['unresolvedEffects']


def _clear_profile(lease):
    lease._record['providerSession'] = None
    lease._record['providerInitialized'] = False
    _write(lease.directory / 'identity.json', lease._record)


def forget(runtime, identity, *, force=False, previous_run=None):
    """Delete a released profile, or explicitly fence its exact abandoned run."""
    from .browser_runtime import _seconds, _project_identity
    _check(runtime, identity)
    if type(force) is not bool or (not force and previous_run is not None):
        raise ValueError('explicit_provider_forget_mode_required')
    previous_run = _prior_binding(previous_run) if force else None
    deadline = time.monotonic() + _seconds(runtime.acquire_seconds, 3600)
    project_id = _project_identity(runtime.project_root, deadline)
    lease = identity._acquire(project_id, recovery=force)
    canonical, clean, fenced = None, not force, False
    try:
        capability, _, _ = read_capability(lease)
        execution = _prior_execution(lease, project_id, previous_run) if force else None
        if force and lease._record.get('providerFence') is not None:
            raise BrowserStateIncomplete('browserless_session_already_fenced_use_recovery')
        canonical = canonical_identity(identity, capability['session']['id'])._acquire(project_id,
            recovery=force, allow_released=force)
        canonical.require_storage_kind('provider-session')
        if force and _prior_execution(canonical, project_id, previous_run) != execution:
            raise BrowserStateIncomplete('browserless_session_previous_run_differs')
        headers = _headers(runtime)
        if origin(capability['session']['stop']) != capability['apiOrigin']:
            headers = {}
        clean = False
        url = _force_url(capability['session']['stop']) if force else capability['session']['stop']
        status, _, evidence = _http(url, 'DELETE', headers=headers, deadline=deadline, directory=lease.directory)
        if status not in {200, 204}:
            raise ProviderSessionIncomplete('browserless_session_forget_incomplete', evidence=evidence['file'], status=status)
        fenced = True
        lease._record['lastProviderForget'] = {'capability': capability, 'evidence': evidence}
        if force:
            proof = {'version': 'treadway.browserless-profile-fence/1', 'binding': lease.binding,
                'execution': execution, 'capability': lease._record['providerSession'], 'evidence': evidence}
            path = lease.directory / ('provider-fence-' + str(uuid.uuid4()) + '.json')
            _write(path, proof)
            lease._record['providerFence'] = {'file': path.name, 'sha256': hashlib.sha256(_read(path)).hexdigest()}
        _write(lease.directory / 'identity.json', lease._record)
        unresolved = []
        if force:
            _, unresolved = _effects(execution, previous_run)
        clean = not unresolved
        if clean:
            _clear_profile(lease)
        return {'forgotten': True, 'profileDeleted': True, 'evidence': evidence['file'],
                'runEvidence': 'retained', 'recoveryRequired': not clean, 'unresolvedEffects': unresolved}
    finally:
        if canonical is not None:
            canonical.release(profile_released=fenced or clean, uncertain=not clean)
        lease.release(profile_released=fenced or clean, context_disposed=clean, uncertain=not clean)


def recover(runtime, identity, *, previous_run):
    """Release a deleted profile's local lease after independent reconciliation."""
    from .browser_runtime import _project_identity
    _check(runtime, identity)
    previous_run = _prior_binding(previous_run)
    project_id = _project_identity(runtime.project_root, time.monotonic() + runtime.acquire_seconds)
    lease = identity._acquire(project_id, recovery=True)
    canonical, clean = None, False
    try:
        capability, _, _ = read_capability(lease)
        execution = _prior_execution(lease, project_id, previous_run)
        pointer = lease._record.get('providerFence')
        try:
            if not isinstance(pointer, dict) or not re.fullmatch(r'provider-fence-[0-9a-f-]{36}\.json', pointer['file']):
                raise ValueError()
            raw = _read(lease.directory / pointer['file'])
            proof = json.loads(raw)
            if (hashlib.sha256(raw).hexdigest() != pointer['sha256'] or proof['version'] != 'treadway.browserless-profile-fence/1'
                    or proof['binding'] != lease.binding or proof['execution'] != execution
                    or proof['capability'] != lease._record['providerSession']
                    or not re.fullmatch(r'provider-http-[0-9a-f-]{36}\.json', proof['evidence']['file'])):
                raise ValueError()
            raw = _read(lease.directory / proof['evidence']['file'])
            receipt = json.loads(raw)
            if (hashlib.sha256(raw).hexdigest() != proof['evidence']['sha256'] or receipt['complete'] is not True
                    or receipt['method'] != 'DELETE' or receipt['url'] != _force_url(capability['session']['stop'])
                    or type(receipt['status']) is not int or receipt['status'] not in {200, 204} or receipt['outcome'] != 'replied'):
                raise ValueError()
        except (ValueError, TypeError, KeyError, OSError):
            raise BrowserStateIncomplete('browserless_session_remote_fence_required') from None
        canonical = canonical_identity(identity, capability['session']['id'])._acquire(project_id,
            recovery=True, allow_released=True)
        canonical.require_storage_kind('provider-session')
        if _prior_execution(canonical, project_id, previous_run) != execution:
            raise BrowserStateIncomplete('browserless_session_previous_run_differs')
        observed, unresolved = _effects(execution, previous_run)
        if unresolved:
            raise BrowserStateIncomplete('browserless_session_effect_reconciliation_required')
        path = lease.directory / ('recovery-' + str(uuid.uuid4()) + '.json')
        _write(path, {'version': 'treadway.browserless-profile-recovery/1', 'binding': lease.binding,
            'execution': execution, 'fence': pointer, 'journalSha256': observed['journalSha256'], 'actors': observed['actors']})
        lease._record['lastRecovery'] = {'file': path.name, 'sha256': hashlib.sha256(_read(path)).hexdigest()}
        _clear_profile(lease)
        clean = True
        return {'recovered': True, 'profileDeleted': True, 'previousGenerationResumed': False}
    finally:
        if canonical is not None:
            canonical.release(profile_released=clean, uncertain=not clean)
        lease.release(profile_released=clean, uncertain=not clean)
