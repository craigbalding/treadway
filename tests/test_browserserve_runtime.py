"""Native Browserserve lifecycle through the public Python API and private IPC."""
import json
from pathlib import Path
import subprocess

import pytest

from treadway.browser_runtime import BrowserRuntime
from treadway.browser_receipts import inspect_browser_run
from treadway.cdp import CdpSocket, CommandSession

ROOT = Path(__file__).resolve().parents[1]
CONFIG = {'provider': 'browserserve', 'binding': 'service', 'endpoint_env': 'TREADWAY_NATIVE_ENDPOINT'}
PRINCIPAL = {'origin': 'https://app.example.invalid', 'probe': '/principal', 'expected': {'principal': 'member'}}


def test_native_configuration_is_passive_and_rejects_unsupported_provider_capabilities(tmp_path):
    runtime = BrowserRuntime(tmp_path/'run', configuration=CONFIG)
    assert runtime.provider == 'browserserve' and runtime.process is None
    for extra in [{'mode': 'borrowed'}, {'mode': 'provider-session'}, {'reconnect': {}},
                  {'session_api_env': 'ANY'}, {'endpoint_env': 'bad name'}]:
        with pytest.raises(ValueError):
            BrowserRuntime(tmp_path/'run', configuration={**CONFIG, **extra})
    assert not list(tmp_path.iterdir())


@pytest.fixture
def endpoint(monkeypatch):
    child = subprocess.Popen(['node', str(ROOT/'tests/remote-protocol-server.js'), 'Infinity', 'browserserve'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    monkeypatch.setenv('TREADWAY_NATIVE_ENDPOINT', json.loads(child.stdout.readline())['endpoint'])
    try:
        yield
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()


def command(runtime, actor, expression):
    with runtime.drive(actor):
        socket = CdpSocket(connection=actor.connection())
        try:
            return CommandSession(socket).command('Runtime.evaluate', {'expression': expression})
        finally:
            socket.close()


def test_native_python_lifecycle_captures_capability_without_prepare_and_retains_valid_receipts(tmp_path, endpoint):
    with BrowserRuntime(tmp_path/'run', configuration=CONFIG, project_root=tmp_path/'project') as runtime:
        actor, other = runtime.acquire_many(['member', 'reviewer'])
        assert actor.provider == 'browserserve' and actor.capabilities['reconnect'] is True
        assert runtime.engine_identity(actor)['scope'] == 'connected-browser'
        command(runtime, actor, 'save:retained')
        for _ in range(2):
            result = runtime.reconnect(actor, principal=PRINCIPAL)
            assert result['generation'] == actor.generation and result['principalVerified'] is True
            assert command(runtime, actor, 'read')['result']['value'] == 'retained'
        assert command(runtime, other, 'read')['result']['value'] == ''
        with pytest.raises(ValueError, match='already_available'):
            runtime.prepare_reconnect(actor)
        cleanup = runtime.release(actor)
        assert cleanup['providerSessionClosed'] is True and cleanup['complete'] is True
        runtime.release(other)
        retained = inspect_browser_run(runtime.evidence, project_id=runtime.project_id, run_id=runtime.run_id)
        assert retained['journalComplete'] is True
        assert all(a['provider'] == 'browserserve' for a in retained['actors'])
        observed = next(a for a in retained['actors'] if a['actor'] == 'member')
        assert len([r for r in observed['reconnections'] if r['kind'] == 'reconnect_ready']) == 2
        assert all(r['evidenceValid'] for r in observed['reconnections'] if 'evidence' in r)
