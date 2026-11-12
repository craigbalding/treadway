"""Explicit named credential references. No secret store, login or renewal.

Constructors are passive. Only ``CredentialResolver.read`` retrieves a value;
plain strings returned here belong inside application helpers, not Robot logs.
Robot users should use :mod:`treadway.credentials_robot` instead.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import sys
from types import MappingProxyType
from typing import Mapping, Protocol

from .process import run_json_process


class CredentialUnavailable(RuntimeError):
    """Resolution failed. Provider output and exception text are private."""


def _text(value):
    if not isinstance(value, str) or not value or len(value.encode()) > 65536 or '\x00' in value:
        raise ValueError("nonempty_credential_text_required")
    return value


def _timeout(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 60:
        raise ValueError("credential_timeout_must_be_between_zero_and_60")
    return value


def _credential_text(value):
    # Empty is an intentional value, distinct from a missing reference. Do not
    # repair negative-test inputs or silently choose another account.
    if not isinstance(value, str) or len(value.encode()) > 65536:
        raise ValueError("credential_text_required")
    return value


@dataclass(frozen=True)
class CredentialRef:
    provider: str
    name: str
    field: str | None = None

    def __post_init__(self):
        _text(self.provider)
        _text(self.name)
        if self.field is not None:
            _text(self.field)


class CredentialProvider(Protocol):
    def read(self, reference: CredentialRef) -> str:
        """Retrieve this exact reference once. Do not log values or renew sessions."""


@dataclass(frozen=True)
class Identity:
    name: str
    expected: Mapping
    credentials: Mapping[str, CredentialRef]

    def __post_init__(self):
        _text(self.name)
        if not isinstance(self.expected, Mapping) or not self.expected:
            raise ValueError("concrete_identity_expectations_required")
        expected = dict(self.expected)
        for key, value in expected.items():
            if (not isinstance(key, str) or not key or any(not part for part in key.split('.'))
                    or type(value) not in (str, bool, int, float, type(None))
                    or isinstance(value, float) and not math.isfinite(value)):
                raise ValueError("concrete_identity_expectations_required")
        credentials = dict(self.credentials)
        if any(not isinstance(key, str) or not key or not isinstance(ref, CredentialRef)
               for key, ref in credentials.items()):
            raise ValueError("named_credential_references_required")
        object.__setattr__(self, "expected", MappingProxyType(expected))
        object.__setattr__(self, "credentials", MappingProxyType(credentials))


class EnvironmentProvider:
    def read(self, reference):
        if reference.field is not None or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', reference.name):
            raise CredentialUnavailable("environment_reference_invalid")
        try:
            return _credential_text(os.environ[reference.name])
        except Exception:
            raise CredentialUnavailable("environment_credential_unavailable") from None


class OnePasswordProvider:
    """Optional installed ``op`` CLI. No shell, sign-in, retry or disk output."""
    def __init__(self, executable="op", timeout_seconds=10):
        self.executable = _text(executable)
        self.timeout_seconds = _timeout(timeout_seconds)

    def read(self, reference):
        if (reference.field is not None or not reference.name.startswith('op://')
                or len(reference.name.removeprefix('op://').split('/')) < 3):
            raise CredentialUnavailable("onepassword_reference_invalid")
        try:
            # The shared transport retains stdout privately and bounds the whole
            # process group. Raw op output need not itself be JSON.
            result = run_json_process([self.executable, "read", "--no-newline", reference.name],
                                      timeout_seconds=self.timeout_seconds, preserve_newlines=True)
            if result['exitCode'] != 0 or result['failure'] not in (None, 'invalid_json_output'):
                raise ValueError()
            return _credential_text(result['stdout'])
        except Exception:
            raise CredentialUnavailable("onepassword_credential_unavailable") from None


class RpaVaultProvider:
    """Optional RPA Vault adapters, isolated so library logs stay private."""
    def __init__(self, mode="control-room", secret_file=None, timeout_seconds=10):
        if mode not in ("control-room", "file") or (mode == "file") != (secret_file is not None):
            raise ValueError("explicit_rpa_vault_mode_and_file_required")
        self.mode = mode
        self.secret_file = None if secret_file is None else str(Path(secret_file).absolute())
        self.timeout_seconds = _timeout(timeout_seconds)

    def read(self, reference):
        if reference.field is None:
            raise CredentialUnavailable("rpa_vault_field_required")
        try:
            result = run_json_process([sys.executable, "-m", "treadway.credential_worker"],
                input_data=json.dumps({"mode": self.mode, "secret_file": self.secret_file,
                                       "name": reference.name, "field": reference.field}),
                timeout_seconds=self.timeout_seconds)
            if result['failure'] is not None or result['exitCode'] != 0:
                raise ValueError()
            return _credential_text(result['payload']['value'])
        except Exception:
            raise CredentialUnavailable("rpa_vault_credential_unavailable; install treadway[vault-rpa] if needed") from None


class CredentialResolver:
    """Identity metadata and provider bindings, with no cached credential values."""
    def __init__(self, identities: Mapping[str, Identity], providers: Mapping[str, CredentialProvider]):
        self.identities = MappingProxyType(dict(identities))
        self.providers = MappingProxyType(dict(providers))
        for name, identity in self.identities.items():
            if not isinstance(identity, Identity) or identity.name != name:
                raise ValueError("identity_name_mismatch")
            if any(ref.provider not in self.providers for ref in identity.credentials.values()):
                raise ValueError("credential_provider_missing")

    def identity(self, name):
        try:
            return self.identities[name]
        except (KeyError, TypeError):
            raise CredentialUnavailable("identity_not_configured") from None

    def read(self, identity, field):
        try:
            reference = self.identity(identity).credentials[field]
            return _credential_text(self.providers[reference.provider].read(reference))
        except Exception:
            # Never copy provider errors, stderr, values or account identifiers
            # into Robot's failure message or exception chaining.
            raise CredentialUnavailable("credential_unavailable; no fallback or login attempted") from None

    @classmethod
    def from_file(cls, path):
        """Read a reference-only JSON config, without contacting any provider."""
        path = Path(path).absolute()
        try:
            config = json.loads(path.read_text())
            if set(config) != {"providers", "identities"}:
                raise ValueError()
            providers = {}
            for name, options in config['providers'].items():
                options = dict(options)
                kind = options.pop('type')
                if kind == 'environment' and not options:
                    provider = EnvironmentProvider()
                elif kind == '1password':
                    provider = OnePasswordProvider(**options)
                elif kind == 'rpa-vault':
                    if options.get('secret_file') is not None:
                        options['secret_file'] = path.parent / options['secret_file']
                    provider = RpaVaultProvider(**options)
                elif kind == 'safeyolo-gateway':
                    from .credentials_safeyolo import SafeYoloGatewayProvider
                    provider = SafeYoloGatewayProvider(**options)
                else:
                    raise ValueError()
                providers[name] = provider
            identities = {}
            for name, spec in config['identities'].items():
                if set(spec) != {'expected', 'credentials'}:
                    raise ValueError()
                identities[name] = Identity(name, spec['expected'],
                    {key: CredentialRef(**ref) for key, ref in spec['credentials'].items()})
            return cls(identities, providers)
        except Exception:
            raise ValueError("credential_reference_configuration_invalid") from None
