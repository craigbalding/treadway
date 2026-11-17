"""Offline ownership contracts; no browser, credentials or network required."""
import os
import subprocess
import sys

import pytest

from treadway.browser_state import BrowserIdentity, BrowserStateIncomplete
from treadway.browser_runtime import BrowserRuntime


def identity(tmp_path, **changes):
    return BrowserIdentity(**{'root': tmp_path/'state', 'resource': 'synthetic-resource', 'application': 'workboard',
        'identity_ref': 'member', 'provider_binding': 'browser-service', 'origins': ('https://app.example.invalid',), **changes})


def snapshot(lease, **changes):
    return {'version': 'treadway.browser-state/1', 'binding': lease.binding, 'complete': True,
            'sourceGeneration': 'synthetic-generation', 'cookies': [], 'storage': {}, **changes}


def test_constructor_and_unsupported_requirements_are_passive(tmp_path):
    state = identity(tmp_path)
    assert not list(tmp_path.iterdir())
    assert 'synthetic-resource' not in repr(state)
    with pytest.raises(ValueError, match='component_unsupported'):
        identity(tmp_path, components=('cookies', 'indexedDB'))
    with pytest.raises(ValueError, match='multi_origin_web_storage_unsupported'):
        identity(tmp_path, origins=('https://app.example.invalid', 'https://login.example.invalid'), components=('localStorage',))
    assert not list(tmp_path.iterdir())


def test_complete_scoped_state_survives_release_and_new_generation(tmp_path):
    state = identity(tmp_path)
    lease = state.acquire('project-one')
    with pytest.raises(BrowserStateIncomplete, match='state_missing'):
        lease.read()
    saved = snapshot(lease, cookies=[{'name': 'synthetic', 'value': 'private-fixture'}])
    assert lease.save(saved)['saved'] is True
    assert lease.release(context_disposed=True, uncertain=False)['recoveryRequired'] is False
    second = state.acquire('project-one')
    try:
        assert second.read() == saved
    finally:
        second.release(context_disposed=True, uncertain=False)
    assert all(path.stat().st_mode & 0o077 == 0 for path in state.root.rglob('*'))


@pytest.mark.parametrize('changes', [
    {'projectId': 'project-two'}, {'application': 'another-application'}, {'identityRef': 'reviewer'},
    {'providerBinding': 'another-provider'}, {'origins': ['https://other.example.invalid']}, {'components': ['localStorage']},
])
def test_snapshot_binding_differences_are_refused_before_replacing_state(tmp_path, changes):
    lease = identity(tmp_path).acquire('project-one')
    try:
        valid = snapshot(lease)
        lease.save(valid)
        with pytest.raises(BrowserStateIncomplete, match='binding_differs'):
            lease.save(snapshot(lease, binding={**lease.binding, **changes}))
        assert lease.read() == valid
        with pytest.raises(BrowserStateIncomplete, match='binding_differs'):
            lease.save(snapshot(lease, complete=False))
    finally:
        lease.release(context_disposed=True, uncertain=False)


def test_aliases_of_one_resource_cannot_create_parallel_writers(tmp_path):
    first = identity(tmp_path).acquire('project-one')
    try:
        for state, project in [(identity(tmp_path), 'project-one'),
                               (identity(tmp_path, identity_ref='alias'), 'project-two')]:
            with pytest.raises(BrowserStateIncomplete, match='identity_in_use'):
                state.acquire(project)
    finally:
        first.release(context_disposed=True, uncertain=False)
    with pytest.raises(BrowserStateIncomplete, match='binding_differs'):
        identity(tmp_path).acquire('project-two')


@pytest.mark.parametrize('cleanup', [{}, {'context_disposed': True},
    {'context_disposed': False, 'uncertain': False}, {'context_disposed': 'yes', 'uncertain': False}])
def test_unknown_cleanup_never_makes_identity_available_for_reuse(tmp_path, cleanup):
    state = identity(tmp_path)
    lease = state.acquire('project-one')
    assert lease.release(**cleanup)['recoveryRequired'] is True
    with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
        state.acquire('project-one')


def test_process_death_releases_lock_but_never_clears_recovery_requirement(tmp_path):
    script = """
import os,sys
from pathlib import Path
from treadway.browser_state import BrowserIdentity
s=BrowserIdentity(Path(sys.argv[1]),'synthetic-resource','workboard','member','browser-service',('https://app.example.invalid',))
lease=s.acquire('project-one')
os._exit(0)
"""
    subprocess.run([sys.executable, '-c', script, str(tmp_path/'state')], check=True, timeout=5)
    with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
        identity(tmp_path).acquire('project-one')


def test_modified_or_public_snapshot_is_never_silently_used(tmp_path):
    lease = identity(tmp_path).acquire('project-one')
    try:
        lease.save(snapshot(lease))
        path = next(lease.directory.glob('state-*.json'))
        path.chmod(0o644)
        with pytest.raises(BrowserStateIncomplete, match='private_bounded'):
            lease.read()
        path.chmod(0o600)
        path.write_text('{}')
        with pytest.raises(BrowserStateIncomplete, match='snapshot_differs'):
            lease.read()
    finally:
        lease.release(context_disposed=True, uncertain=False)


def test_symlinks_and_hardlink_aliases_are_not_state_authority(tmp_path):
    actual = tmp_path/'actual'
    actual.mkdir(mode=0o700)
    link = tmp_path/'state'
    link.symlink_to(actual, target_is_directory=True)
    with pytest.raises(BrowserStateIncomplete, match='private_browser_identity_directory_required'):
        identity(tmp_path).acquire('project-one')
    link.unlink()
    lease = identity(tmp_path).acquire('project-one')
    try:
        lease.save(snapshot(lease))
        path = next(lease.directory.glob('state-*.json'))
        os.link(path, tmp_path/'alias')
        with pytest.raises(BrowserStateIncomplete, match='private_bounded'):
            lease.read()
    finally:
        lease.release(context_disposed=True, uncertain=False)


def test_forget_is_explicit_exclusive_and_retains_binding(tmp_path):
    state = identity(tmp_path)
    lease = state.acquire('project-one')
    lease.save(snapshot(lease))
    lease.save(snapshot(lease, sourceGeneration='generation-two'))
    with pytest.raises(BrowserStateIncomplete, match='identity_in_use'):
        state.forget('project-one')
    lease.release(context_disposed=True, uncertain=False)
    assert state.forget('project-one')['forgotten'] is True
    assert not list(state.root.rglob('state-*.json'))
    with pytest.raises(BrowserStateIncomplete, match='binding_differs'):
        state.acquire('project-two')
    fresh = state.acquire('project-one')
    try:
        with pytest.raises(BrowserStateIncomplete, match='state_missing'):
            fresh.read()
    finally:
        fresh.release(context_disposed=True, uncertain=False)


def test_missing_state_does_not_start_browser_or_block_explicit_setup(tmp_path, monkeypatch):
    state = identity(tmp_path)
    runtime = BrowserRuntime(tmp_path/'run', project_root=tmp_path/'project', configuration={
        'provider': 'browserless', 'binding': 'browser-service', 'endpoint_env': 'TREADWAY_ABSENT_ENDPOINT'})
    monkeypatch.delenv('TREADWAY_ABSENT_ENDPOINT', raising=False)
    principal = {'origin': state.origins[0], 'probe': '/principal', 'expected': {'principal': 'member'}}
    with pytest.raises(BrowserStateIncomplete, match='state_missing'):
        runtime.acquire_identity('member', state, principal=principal)
    assert runtime.process is None
    assert not runtime.root.exists()
    record = next(state.root.rglob('identity.json'))
    import json
    project = json.loads(record.read_text())['binding']['projectId']
    setup = state.acquire(project)
    setup.release(context_disposed=True, uncertain=False)


@pytest.mark.parametrize('changes', [
    {'actor': '../member'}, {'principal': {'origin': 'https://app.example.invalid', 'probe': '/principal',
      'expected': {'principal': 'member'}, 'generation': 'forged'}},
    {'persistent': True},
])
def test_invalid_identity_acquisition_is_passive(tmp_path, changes):
    runtime = BrowserRuntime(tmp_path/'run', project_root=tmp_path/'project', configuration={
        'provider': 'browserless', 'binding': 'browser-service', 'endpoint_env': 'TREADWAY_ABSENT_ENDPOINT'})
    arguments = {'actor': 'member', 'principal': {'origin': 'https://app.example.invalid',
                 'probe': '/principal', 'expected': {'principal': 'member'}}, **changes}
    with pytest.raises(ValueError):
        runtime.acquire_identity(identity=identity(tmp_path), **arguments)
    assert not list(tmp_path.iterdir())
