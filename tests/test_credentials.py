"""Credential references are passive, exact and never an authentication policy."""
import json
import os
from pathlib import Path
import sys

import pytest

from treadway.credentials import (CredentialRef, CredentialResolver, CredentialUnavailable,
    EnvironmentProvider, Identity, OnePasswordProvider, RpaVaultProvider)


def resolver(provider, reference=None):
    reference = reference or CredentialRef('source', 'FIXTURE_CREDENTIAL')
    return CredentialResolver({'reviewer': Identity('reviewer', {'principal': 'user-b'}, {'password': reference})},
                              {'source': provider})


def test_environment_reads_only_on_explicit_resolution_and_does_not_cache(monkeypatch):
    source = resolver(EnvironmentProvider())
    assert source.identity('reviewer').expected == {'principal': 'user-b'}
    with pytest.raises(CredentialUnavailable):
        source.read('reviewer', 'password')
    monkeypatch.setenv('FIXTURE_CREDENTIAL', 'first-synthetic-value')
    assert source.read('reviewer', 'password') == 'first-synthetic-value'
    monkeypatch.setenv('FIXTURE_CREDENTIAL', '')
    assert source.read('reviewer', 'password') == ''  # Explicit negative-test input.
    monkeypatch.setenv('FIXTURE_CREDENTIAL', 'second-synthetic-value')
    assert source.read('reviewer', 'password') == 'second-synthetic-value'
    assert 'synthetic-value' not in repr(source)


def test_identity_configuration_is_immutable_and_not_live_principal_proof():
    expected = {'principal': 'configured-only'}
    credentials = {'password': CredentialRef('source', 'FIXTURE_CREDENTIAL')}
    identity = Identity('reviewer', expected, credentials)
    expected['principal'] = 'changed'
    credentials.clear()
    assert identity.expected['principal'] == 'configured-only'
    assert identity.credentials['password'].name == 'FIXTURE_CREDENTIAL'
    with pytest.raises(TypeError):
        identity.expected['principal'] = 'changed'


def test_missing_identity_or_field_never_calls_another_provider():
    class Source:
        def read(self, _):
            raise AssertionError('must not contact provider')
    source = resolver(Source())
    for identity, field in [('missing', 'password'), ('reviewer', 'missing')]:
        with pytest.raises(CredentialUnavailable, match='no fallback or login attempted'):
            source.read(identity, field)


def test_provider_errors_and_nontext_values_do_not_disclose_secret(capsys):
    class Source:
        def read(self, _):
            raise RuntimeError('synthetic-sensitive-error')
    with pytest.raises(CredentialUnavailable) as error:
        resolver(Source()).read('reviewer', 'password')
    assert 'synthetic-sensitive-error' not in str(error.value)
    assert error.value.__suppress_context__
    assert capsys.readouterr() == ('', '')
    class NonText:
        def read(self, _):
            return {'password': 'synthetic-sensitive-error'}
    with pytest.raises(CredentialUnavailable):
        resolver(NonText()).read('reviewer', 'password')


def config_file(tmp_path, providers=None):
    file = tmp_path/'identities.json'
    file.write_text(json.dumps({'providers': providers or {'source': {'type': 'environment'}},
        'identities': {'reviewer': {'expected': {'principal': 'user-b'}, 'credentials': {
            'password': {'provider': 'source', 'name': 'FIXTURE_CREDENTIAL'}}}}}))
    return file


def test_config_load_is_passive_and_rejects_unknown_or_literal_fields(tmp_path, monkeypatch):
    file = config_file(tmp_path)
    monkeypatch.delenv('FIXTURE_CREDENTIAL', raising=False)
    source = CredentialResolver.from_file(file)
    assert source.identity('reviewer').name == 'reviewer'
    for key, value in [('value', 'synthetic-plaintext'), ('provider', 'missing')]:
        data = json.loads(file.read_text())
        data['identities']['reviewer']['credentials']['password'][key] = value
        file.write_text(json.dumps(data))
        with pytest.raises(ValueError, match='configuration_invalid') as error:
            CredentialResolver.from_file(file)
        assert 'synthetic-plaintext' not in str(error.value)
        config_file(tmp_path)


def op_fixture(tmp_path):
    file = tmp_path/'synthetic-op'
    file.write_text('#!'+sys.executable+'\n'
        'import os,sys,time,json,subprocess\nfrom pathlib import Path\n'
        'assert sys.argv[1:3]==["read","--no-newline"]\n'
        'Path(os.environ["OP_FIXTURE_ARGS"]).write_text(json.dumps(sys.argv[1:]))\n'
        'if os.environ.get("OP_FIXTURE_FAIL"):\n'
        ' print("synthetic-sensitive-error",file=sys.stderr);sys.exit(1)\n'
        'if os.environ.get("OP_FIXTURE_HANG"):\n'
        ' child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"])\n'
        ' Path(os.environ["OP_FIXTURE_HANG"]).write_text(str(child.pid))\n'
        ' time.sleep(60)\n'
        'sys.stdout.write(os.environ["OP_FIXTURE_VALUE"])\n')
    file.chmod(0o700)
    return file


def test_onepassword_cli_exact_reference_private_output_and_no_normalization(tmp_path, monkeypatch, capsys):
    args = tmp_path/'args.json'
    monkeypatch.setenv('OP_FIXTURE_ARGS', str(args))
    monkeypatch.setenv('OP_FIXTURE_VALUE', ' synthetic-password\r\nwith-bare\rreturn\n')
    reference = CredentialRef('source', 'op://synthetic/reviewer/password')
    source = resolver(OnePasswordProvider(str(op_fixture(tmp_path))), reference)
    assert not args.exists()
    assert source.read('reviewer', 'password') == ' synthetic-password\r\nwith-bare\rreturn\n'
    assert json.loads(args.read_text()) == ['read', '--no-newline', reference.name]
    monkeypatch.setenv('OP_FIXTURE_FAIL', '1')
    with pytest.raises(CredentialUnavailable) as error:
        source.read('reviewer', 'password')
    assert 'synthetic-sensitive-error' not in str(error.value)
    assert capsys.readouterr() == ('', '')


@pytest.mark.skipif(os.name != 'posix', reason='POSIX process-group contract')
def test_onepassword_timeout_stops_descendants_and_retains_no_secret_error(tmp_path, monkeypatch):
    import time
    monkeypatch.setenv('OP_FIXTURE_ARGS', str(tmp_path/'args.json'))
    pid = tmp_path/'child.pid'
    monkeypatch.setenv('OP_FIXTURE_HANG', str(pid))
    source = resolver(OnePasswordProvider(str(op_fixture(tmp_path)), timeout_seconds=1),
                      CredentialRef('source', 'op://synthetic/reviewer/password'))
    started = time.monotonic()
    with pytest.raises(CredentialUnavailable):
        source.read('reviewer', 'password')
    assert time.monotonic()-started < 4
    child = int(pid.read_text())
    # An orphan killed child may remain briefly as a zombie pending init reaping.
    stat = Path(f'/proc/{child}/stat')
    assert not stat.exists() or stat.read_text().split()[2] == 'Z'


@pytest.mark.parametrize('options', [{'timeout_seconds': 0}, {'timeout_seconds': True},
                                    {'timeout_seconds': float('nan')}])
def test_external_provider_deadlines_are_explicit(options):
    with pytest.raises(ValueError):
        OnePasswordProvider(**options)
    with pytest.raises(ValueError):
        RpaVaultProvider(**options)


def test_rpa_provider_is_lazy_and_private_even_if_dependency_unavailable(monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return {'failure': None, 'exitCode': 0, 'payload': {'value': 'synthetic-vault-value'}}
    monkeypatch.setattr('treadway.credentials.run_json_process', run)
    source = resolver(RpaVaultProvider(), CredentialRef('source', 'reviewer', 'password'))
    assert not calls
    assert source.read('reviewer', 'password') == 'synthetic-vault-value'
    assert calls[0][0] == [sys.executable, '-m', 'treadway.credential_worker']
    assert json.loads(calls[0][1]['input_data'])['name'] == 'reviewer'


def test_real_optional_rpa_file_adapter_selects_only_requested_bundle_field(tmp_path, monkeypatch):
    pytest.importorskip('RPA.Robocorp.Vault')
    secrets = tmp_path/'private.json'
    secrets.write_text(json.dumps({'reviewer': {'password': 'synthetic-vault-value'},
                                  'creator': {'password': 'other-synthetic-value'}}))
    secrets.chmod(0o600)
    monkeypatch.setenv('RPA_SECRET_FILE', str(tmp_path/'wrong-file.json'))
    monkeypatch.setenv('RPA_SECRET_MANAGER', 'not.the.configured.provider')
    source = resolver(RpaVaultProvider(mode='file', secret_file=secrets),
                      CredentialRef('source', 'reviewer', 'password'))
    before = secrets.read_bytes()
    assert source.read('reviewer', 'password') == 'synthetic-vault-value'
    configuration = tmp_path/'identities.json'
    configuration.write_text(json.dumps({'providers': {'source': {
        'type': 'rpa-vault', 'mode': 'file', 'secret_file': 'private.json'}},
        'identities': {'reviewer': {'expected': {'principal': 'user-b'}, 'credentials': {
            'password': {'provider': 'source', 'name': 'reviewer', 'field': 'password'}}}}}))
    elsewhere = tmp_path/'other-working-directory'
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    assert CredentialResolver.from_file(configuration).read('reviewer', 'password') == 'synthetic-vault-value'
    assert secrets.read_bytes() == before
    missing = resolver(RpaVaultProvider(mode='file', secret_file=secrets),
                       CredentialRef('source', 'missing', 'password'))
    with pytest.raises(CredentialUnavailable):
        missing.read('reviewer', 'password')
    # A configured hosted source must not pick up a valid local-file adapter
    # from ambient RPA settings when hosted credentials are unavailable.
    for name in ('RC_API_SECRET_HOST', 'RC_API_SECRET_TOKEN', 'RC_WORKSPACE_ID'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('RPA_SECRET_MANAGER', 'RPA.Robocorp.Vault.FileSecrets')
    monkeypatch.setenv('RPA_SECRET_FILE', str(secrets))
    hosted = resolver(RpaVaultProvider(), CredentialRef('source', 'reviewer', 'password'))
    with pytest.raises(CredentialUnavailable):
        hosted.read('reviewer', 'password')


def test_safeyolo_reads_exact_existing_binding_only_on_resolution(tmp_path, monkeypatch):
    from treadway.credentials_safeyolo import SafeYoloGatewayProvider
    calls = []
    binding = {'capability': 'reader', 'account': 'reviewer', 'token': 'sgw_synthetic_fixture'}
    class Observation:
        complete, status = True, 200
        def json(self):
            return {'authorized': {'workboard': binding}, 'available': []}
    class Client:
        def __init__(self, **kwargs):
            assert kwargs['origin'] == 'http://_safeyolo.proxy.internal'
            self.headers = kwargs['credential_headers']
        def request(self, path, **kwargs):
            assert self.headers() == {'Authorization': 'Bearer synthetic-api-fixture'}
            calls.append(path)
            return Observation()
    monkeypatch.setattr('treadway.credentials_safeyolo.HttpSession', Client)
    token_file = tmp_path/'api-token'
    provider = SafeYoloGatewayProvider('workboard', 'reader', 'reviewer', agent_token_file=token_file)
    source = resolver(provider, CredentialRef('source', 'token'))
    assert not calls
    token_file.write_text('synthetic-api-fixture\n')
    assert source.read('reviewer', 'password') == 'sgw_synthetic_fixture'
    for key in ('account', 'capability'):
        before = binding[key]
        binding[key] = 'different'
        with pytest.raises(CredentialUnavailable):
            source.read('reviewer', 'password')
        binding[key] = before
    binding['token'] = 'not-a-gateway-token'
    with pytest.raises(CredentialUnavailable):
        source.read('reviewer', 'password')
    assert calls == ['/gateway/services']*4


@pytest.mark.skipif(os.name != 'posix', reason='POSIX token-file guard')
def test_gateway_api_token_refuses_pipes_symlinks_and_oversized_files(tmp_path):
    from treadway.credentials_safeyolo import SafeYoloGatewayProvider
    file = tmp_path/'token'
    file.write_text('synthetic-api-token')
    link = tmp_path/'link'
    link.symlink_to(file)
    fifo = tmp_path/'fifo'
    os.mkfifo(fifo)
    for path in (link, fifo):
        with pytest.raises((OSError, ValueError)):
            SafeYoloGatewayProvider('service', 'reader', 'reviewer', agent_token_file=path)._agent_headers()
    file.write_text('x'*4097)
    with pytest.raises(ValueError):
        SafeYoloGatewayProvider('service', 'reader', 'reviewer', agent_token_file=file)._agent_headers()
