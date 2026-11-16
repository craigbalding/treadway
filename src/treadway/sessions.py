"""Explicit single-dispatch HTTP sessions. Recovery is opt-in in ``recovery``.

Credential providers run only inside the request operation. A named session is
not a principal assertion; applications supply their read-only identity probe.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from http.cookiejar import Cookie, CookieJar
from http.client import HTTPConnection, HTTPSConnection, HTTPException, HTTPResponse
import io
import json
import math
import re
from threading import Lock
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPHandler, HTTPSHandler, HTTPRedirectHandler, HTTPCookieProcessor, Request, build_opener
import uuid

from . import diagnostics as diag

_read_only = ContextVar('treadway_http_observation_only', default=False)


class HttpFailure(RuntimeError):
    """Structured failure; raw observations stay private, never in the message.

    ``dispatch`` describes the dependent action, not an earlier identity probe.
    Possibly started is deliberately conservative: a transport exception cannot
    establish whether the server received or committed an operation.
    """
    def __init__(self, code, *, phase, dispatch="not_started", observation=None,
                 principal="unknown", error_type=None):
        self.code, self.phase, self.dispatch = code, phase, dispatch
        self.observation, self.principal, self.error_type = observation, principal, error_type
        super().__init__(code + ("; action not dispatched" if dispatch == "not_started"
                                 else "; application effect unknown"))


def principal_state(observed, expected):
    """Expected/wrong/unknown; only an application can classify unauthenticated.

    A missing field, invalid JSON or partial response is unknown. An explicit
    different non-null value is wrong. Null remains available to an explicit
    application classifier as a possible unauthenticated state.
    """
    if not observed.complete or observed.status != 200:
        return "unknown"
    try:
        actual = observed.json()
    except (TypeError, ValueError):
        return "unknown"
    state = "expected"
    for path, wanted in expected.items():
        value = actual
        try:
            for part in path.split("."):
                value = value[part]
        except (KeyError, IndexError, TypeError):
            state = "unknown"
            continue
        if type(value) is not type(wanted) or value != wanted:
            if value is not None:
                return "wrong"
            state = "unknown"
    return state


def validate_expected(expected):
    if (not isinstance(expected, dict) or not expected
            or any(not isinstance(key, str) or not key or any(not p for p in key.split("."))
                   or type(value) not in (str, bool, int, float, type(None))
                   or type(value) is float and not math.isfinite(value)
                   for key, value in expected.items())):
        raise ValueError("concrete_principal_expectations_required")


def encode_body(body):
    """Exact JSON encoding shared by transport and durable operation intent."""
    return None if body is None else json.dumps(body, sort_keys=True, separators=(",", ":"),
                                               ensure_ascii=False, allow_nan=False).encode()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class DeadlineReader(io.RawIOBase):
    """Apply the remaining budget on each socket read, including header lines."""
    def __init__(self, raw, deadline):
        self.raw, self.deadline = raw, deadline

    def readable(self):
        return True

    def readinto(self, buffer):
        remaining = self.deadline-time.monotonic()
        if remaining <= 0:
            raise TimeoutError("http_response_deadline")
        self.raw._sock.settimeout(remaining)
        return self.raw.readinto(buffer)

    def close(self):
        self.raw.close()
        super().close()


class DeadlineResponse(HTTPResponse):
    def __init__(self, *args, deadline, **kwargs):
        super().__init__(*args, **kwargs)
        raw = self.fp.detach()
        self.fp = io.BufferedReader(DeadlineReader(raw, deadline))


def deadline_client(jar, deadline):
    def connection(connection_type, host, **kwargs):
        client = connection_type(host, **kwargs)
        client.response_class = lambda *args, **options: DeadlineResponse(*args, deadline=deadline, **options)
        return client

    class Plain(HTTPHandler):
        def http_open(self, request):
            return self.do_open(lambda host, **options: connection(HTTPConnection, host, **options), request)

    class Secure(HTTPSHandler):
        def https_open(self, request):
            return self.do_open(lambda host, **options: connection(HTTPSConnection, host, **options), request,
                                context=self._context)

    return build_opener(Plain(), Secure(), NoRedirect(), HTTPCookieProcessor(jar))


@dataclass(frozen=True)
class HttpObservation:
    actor: str
    session_id: str
    status: int
    complete: bool
    body: bytes = field(repr=False)
    headers: tuple[tuple[str, str], ...] = field(default=(), repr=False)

    def header(self, name, default=None):
        """Return the first value, ignoring case; ``headers`` retains duplicates.

        Header values can contain credentials. Keep raw observations private.
        Headers describe the response even when its body is incomplete.
        """
        return next((value for key, value in self.headers if key.lower() == name.lower()), default)

    def json(self):
        if not self.complete:
            raise ValueError("response_body_incomplete")
        return json.loads(self.body)


class HttpSession:
    @contextmanager
    def observation_only(self):
        """Disallow state-changing HTTP methods during explicit reconciliation."""
        token = _read_only.set(True)
        try:
            yield
        finally:
            _read_only.reset(token)

    def __init__(self, *, actor, origin, credential_headers=None, max_body_bytes=65536):
        parsed = urlsplit(origin)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or not actor or type(max_body_bytes) is not int or max_body_bytes <= 0):
            raise ValueError("explicit_actor_origin_required")
        self.actor, self.origin = actor, origin
        self.session_id = uuid.uuid4().hex
        self._credentials = credential_headers
        self._jar = CookieJar()
        self._lock = Lock()
        self.max_body_bytes = max_body_bytes

    @contextmanager
    def _lease(self):
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("actor_session_in_use")
        try:
            yield
        finally:
            self._lock.release()

    def _url(self, path):
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
            raise ValueError("same_origin_path_required")
        url = urljoin(self.origin, path)
        if urlsplit(url)._replace(path="", query="", fragment="").geturl() != self.origin or urlsplit(url).fragment:
            raise ValueError("same_origin_path_required")
        return url

    def _headers(self, headers=None, *, base=None):
        try:
            result = dict(base if base is not None else self._credentials() if self._credentials else {})
            for key, value in (headers or {}).items():
                if any(k.lower() == key.lower() for k in result):
                    raise ValueError("duplicate_header")
                result[key] = value
            if any(not isinstance(k, str) or not isinstance(v, str)
                   or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", k)
                   or any(ord(c) < 32 or ord(c) == 127 for c in v)
                   for k, v in result.items()):
                raise ValueError("invalid_header")
            return result
        except Exception as error:
            raise HttpFailure("actor_http_credentials_incomplete", phase="credentials",
                              error_type=type(error).__name__) from None

    def _request(self, path, method, body, timeout_seconds, *, headers=None, phase="request"):
        with diag.span('http', phase=phase, method=method, target_ref=diag.reference((self.origin, path))) as trace:
            if method != 'GET':
                if _read_only.get():
                    raise HttpFailure('read_only_observation_required', phase='prerequisite')
                diag.checkpoint()
            response = self._request_observed(path, method, body, timeout_seconds, headers=headers, phase=phase)
            trace.update(http_status=response.status, complete=response.complete, bytes=len(response.body))
            return response

    def _request_observed(self, path, method, body, timeout_seconds, *, headers=None, phase="request"):
        url = self._url(path)
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"} or not 0 < timeout_seconds <= 60:
            raise ValueError("bounded_explicit_request_required")
        try:
            data = encode_body(body)
            prepared = dict(headers) if headers is not None else self._headers()
            if body is not None:
                prepared.setdefault("Content-Type", "application/json")
            request = Request(url, data=data, headers=prepared, method=method)
            deadline = time.monotonic()+timeout_seconds
            client = deadline_client(self._jar, deadline)
        except HttpFailure:
            raise
        except Exception as error:
            raise HttpFailure("actor_http_preparation_incomplete", phase="preparation",
                              error_type=type(error).__name__) from None
        try:
            try:
                diag.emit('http_dispatched', level='DEBUG', phase=phase, method=method, dispatch='possibly_started')
                response = client.open(request, timeout=timeout_seconds)
            except HTTPError as error:
                response = error
            with response:
                stream = response.fp if isinstance(response, HTTPError) else response
                content = bytearray()
                complete = True
                while len(content) <= self.max_body_bytes:
                    remaining = deadline-time.monotonic()
                    if remaining <= 0:
                        complete = False
                        break
                    try:
                        chunk = stream.read1(min(65536, self.max_body_bytes+1-len(content)))
                        if not chunk:
                            break
                        content.extend(chunk)
                    except (OSError, HTTPException):
                        complete = False
                        break
                declared = response.headers.get("Content-Length")
                if declared is not None and (not declared.isdecimal() or len(content) != int(declared)):
                    complete = False
                return HttpObservation(self.actor, self.session_id, response.code,
                                       complete and len(content) <= self.max_body_bytes, bytes(content[:self.max_body_bytes]),
                                       tuple(response.headers.items()))
        except Exception as error:
            raise HttpFailure("actor_http_observation_incomplete", phase=phase,
                              dispatch="possibly_started", error_type=type(error).__name__) from None

    def request(self, path, *, method="GET", body=None, timeout_seconds=5, headers=None, phase='request'):
        self._url(path)
        with self._lease():
            return self._request(path, method, body, timeout_seconds, headers=self._headers(headers), phase=phase)

    def import_browser_cookies(self, snapshot, *, generation):
        """Replace this jar from one complete, explicitly bound private snapshot.

        Import does not establish a principal. Use ``attempt`` or an explicit
        application probe afterward. Partitioned cookies cannot be faithfully
        replayed by CookieJar and are refused, without changing existing state.
        Duplicate names at distinct domains/paths remain distinct. SameSite and
        browser metadata are retained, but browser navigation policy is not
        reproduced by this same-origin HTTP client.
        """
        with self._lease():
            if (not isinstance(snapshot, dict) or snapshot.get('version') != 'treadway.cookies/1'
                    or snapshot.get('complete') is not True or not isinstance(generation, str) or not generation
                    or snapshot.get('generation') != generation or snapshot.get('actor') != self.actor
                    or snapshot.get('origin') != self.origin or not isinstance(snapshot.get('cookies'), list)):
                raise ValueError('browser_cookie_snapshot_binding_differs_or_incomplete')
            jar, seen = CookieJar(), set()
            hostname = urlsplit(self.origin).hostname.lower()
            for item in snapshot['cookies']:
                if not isinstance(item, dict):
                    raise ValueError('browser_cookie_snapshot_invalid')
                if item.get('partitionKey') is not None or item.get('partitionKeyOpaque'):
                    raise ValueError('partitioned_browser_cookie_replay_unsupported')
                if (not all(isinstance(item.get(k), str) for k in ('name', 'value', 'domain', 'path'))
                        or not all(type(item.get(k)) is bool for k in ('secure', 'httpOnly', 'session'))
                        or type(item.get('expires')) not in (int, float) or not math.isfinite(item['expires'])):
                    raise ValueError('browser_cookie_snapshot_invalid')
                name, value, domain, path = (item[k] for k in ('name', 'value', 'domain', 'path'))
                domain = domain.lower()
                if (not re.fullmatch(r"[^\x00-\x20\x7f()<>@,;:\\\"/\[\]?={}]+", name)
                        or any(ord(c) < 32 or ord(c) == 127 or c == ';' for c in value)
                        or not path.startswith('/') or any(ord(c) < 32 or ord(c) == 127 for c in path)
                        or not (domain == hostname or domain == '.' + hostname
                                or domain.startswith('.') and hostname.endswith(domain))):
                    raise ValueError('browser_cookie_scope_or_value_invalid')
                identity = domain, path, name
                if identity in seen:
                    raise ValueError('duplicate_browser_cookie_identity')
                seen.add(identity)
                if item.get('sameSite') not in (None, 'Strict', 'Lax', 'None'):
                    raise ValueError('browser_cookie_same_site_unsupported')
                rest = {key: val for key, val in item.items()
                        if key not in {'name', 'value', 'domain', 'path', 'secure', 'expires', 'session'}}
                if item['httpOnly']:
                    rest['HttpOnly'] = None
                jar.set_cookie(Cookie(version=0, name=name, value=value, port=None, port_specified=False,
                    domain=domain, domain_specified=domain.startswith('.'), domain_initial_dot=domain.startswith('.'),
                    path=path, path_specified=True, secure=item['secure'],
                    expires=None if item['session'] else int(item['expires']), discard=item['session'],
                    comment=None, comment_url=None, rest=rest, rfc2109=False))
            self._jar = jar
            return {'complete': True, 'imported': len(seen), 'actor': self.actor, 'generation': generation,
                    'limits': ['SameSite navigation policy is not reproduced',
                               'Import does not verify the application principal']}

    def attempt(self, path, *, probe, expected, method="GET", body=None, timeout_seconds=5,
                headers=None, before_dispatch=None, after_probe_headers=None, volatile_headers=()):
        """Verify this actual session, then dispatch once, preserving failures.

        One credential-header acquisition serves both requests. Cookie updates
        from the probe still apply. ``before_dispatch`` may enforce application
        prerequisites and durably reserve intent; it runs after identity is
        established, before any dependent request is handed to the transport.
        No incidental probe should be used during deliberate expiry testing.
        """
        validate_expected(expected)
        self._url(path)
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"} or not 0 < timeout_seconds <= 60:
            raise ValueError("bounded_explicit_request_required")
        try:
            encode_body(body)
        except Exception as error:
            raise HttpFailure("actor_http_preparation_incomplete", phase="preparation",
                              error_type=type(error).__name__) from None
        with self._lease():
            prepared = self._headers()
            mutation_headers = self._headers(headers, base=prepared)
            try:
                with diag.span('principal_probe', phase='probe') as trace:
                    observed = self._request(probe, "GET", None, timeout_seconds,
                                             headers=prepared, phase="probe")
                    state = principal_state(observed, expected)
                    trace.update(principal=state, http_status=observed.status, complete=observed.complete)
            except HttpFailure as error:
                raise HttpFailure(error.code, phase="probe", error_type=error.error_type) from None
            if state != "expected":
                code = "actual_principal_differs" if state == "wrong" else "actual_principal_unknown"
                raise HttpFailure(code, phase="probe", observation=observed, principal=state)
            if after_probe_headers is not None:
                try:
                    updates = dict(after_probe_headers(observed))
                    permitted = {name.lower() for name in volatile_headers}
                    if (permitted & {"authorization", "cookie", "host", "content-type", "content-length"}
                            or any(key.lower() not in permitted for key in updates)):
                        raise ValueError("post_probe_header_outside_declared_scope")
                    for key, value in updates.items():
                        if (not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value)
                                or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key)):
                            raise ValueError("invalid_header")
                        mutation_headers = {k: v for k, v in mutation_headers.items() if k.lower() != key.lower()}
                        mutation_headers[key] = value
                except Exception as error:
                    raise HttpFailure("actor_post_probe_headers_incomplete", phase="materialization",
                                      observation=observed, principal="expected",
                                      error_type=type(error).__name__) from None
            if before_dispatch is not None:
                try:
                    before_dispatch()
                except diag.FlowChanged as error:
                    failure = HttpFailure('flow_changed_before_dispatch', phase='prerequisite',
                                          observation=observed, principal='expected')
                    failure.flow_change = error.report
                    raise failure from None
                except Exception as error:
                    raise HttpFailure("actor_prerequisite_incomplete", phase="prerequisite",
                                      observation=observed, principal="expected",
                                      error_type=type(error).__name__) from None
            return self._request(path, method, body, timeout_seconds, headers=mutation_headers, phase="mutation")
