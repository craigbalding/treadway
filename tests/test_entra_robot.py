import io
import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
import robot
from robot.libraries.BuiltIn import BuiltIn

from treadway.entra_robot import EntraLibrary


def configuration(tmp_path):
    refs = tmp_path / 'identities.json'
    spec = {'expected': {'user.email': 'member@example.invalid'}, 'credentials': {
        'username': {'provider': 'env', 'name': 'ENTRA_TEST_USERNAME'},
        'password': {'provider': 'env', 'name': 'ENTRA_TEST_PASSWORD'}}}
    refs.write_text(json.dumps({'providers': {'env': {'type': 'environment'}},
                                'identities': {'member': spec, 'reviewer': spec}}))
    config = tmp_path / 'entra.json'
    config.write_text(json.dumps({'credentials': str(refs),
        'application': {'origin': 'https://workboard.example.invalid', 'principal_probe': '/principal'},
        'browser': {'root': str(tmp_path / 'browsers'), 'executable': '/synthetic/chromium'}}))
    return config


def test_native_robot_import_and_dryrun_are_passive(tmp_path):
    library = EntraLibrary(tmp_path / 'missing.json')
    assert library.get_last_entra_result() is None
    suite = tmp_path / 'passive.robot'
    suite.write_text('*** Settings ***\nLibrary    treadway.entra_robot.EntraLibrary    /missing/entra.json\n'
                     '*** Test Cases ***\nImport\n    Sign In With Entra    member\n')
    assert robot.run(str(suite), dryrun=True, outputdir=str(tmp_path / 'dryrun'),
                     stdout=io.StringIO(), stderr=io.StringIO()) == 0


def prepared(tmp_path, monkeypatch, payloads, fail_cleanup=False):
    config = configuration(tmp_path)
    monkeypatch.setenv('ENTRA_TEST_USERNAME', 'member@example.invalid')
    monkeypatch.setenv('ENTRA_TEST_PASSWORD', 'synthetic-native-private-password')
    monkeypatch.setattr(BuiltIn, 'get_variable_value', lambda *args: str(tmp_path / 'output'))
    calls, messages = [], []

    class Manager:
        def __init__(self, root, **options):
            pass

        def start(self, name, **options):
            calls.append(('start', name, options))
            return SimpleNamespace(name=name, generation='generation', port=1000, target_id='target', persistent=True)

        @contextmanager
        def drive(self, session):
            yield session

        def stop(self, session):
            calls.append(('stop', session.name))
            if fail_cleanup:
                raise RuntimeError('synthetic shutdown failure')

    def run(_command, **options):
        data = json.loads(options['input_data'])
        assert data['credentialSource']['identity'] in {'member', 'reviewer'}
        assert 'credentials' not in data
        assert data['options']['screenshotMask'] == 'none'
        return {'payload': payloads.pop(0), 'failure': None, 'exitCode': 0}

    monkeypatch.setattr('treadway.entra_robot.BrowserManager', Manager)
    monkeypatch.setattr('treadway.entra_robot.run_json_process', run)
    monkeypatch.setattr('treadway.entra_robot.logger.info', messages.append)
    return EntraLibrary(config), calls, messages


def test_profile_binding_is_stable_per_identity_and_cleanup_is_owned(tmp_path, monkeypatch):
    library, calls, messages = prepared(tmp_path, monkeypatch, [{'status': 'verified'} for _ in range(3)])
    library.sign_in_with_entra('member')
    library.sign_in_with_entra('member')
    library.sign_in_with_entra('reviewer')
    starts = [call for call in calls if call[0] == 'start']
    assert starts[0][1] == starts[1][1] != starts[2][1]
    assert all(call[2]['persistent'] and call[2]['require_new'] for call in starts)
    assert len([call for call in calls if call[0] == 'stop']) == 3
    assert 'synthetic-native-private-password' not in ''.join(messages)


def test_failed_attempt_survives_successful_retry(tmp_path, monkeypatch):
    library, _, _ = prepared(tmp_path, monkeypatch, [{'status': 'transition_deadline'}, {'status': 'verified'}])
    with pytest.raises(AssertionError, match='transition_deadline'):
        library.sign_in_with_entra('member')
    first = library.get_last_entra_result()['robotEvidence']
    library.sign_in_with_entra('member')
    second = library.get_last_entra_result()['robotEvidence']
    assert first != second
    from pathlib import Path
    assert json.loads(Path(first).read_text())['status'] == 'transition_deadline'


def test_cleanup_failure_keeps_authentication_verified_and_does_not_retry(tmp_path, monkeypatch):
    library, calls, _ = prepared(tmp_path, monkeypatch, [{'status': 'verified'}], fail_cleanup=True)
    with pytest.raises(AssertionError, match='authentication verified; browser cleanup incomplete'):
        library.sign_in_with_entra('member')
    assert library.get_last_entra_result()['status'] == 'verified'
    assert library.get_last_entra_result()['cleanup'] == {'complete': False}
    assert len([call for call in calls if call[0] == 'start']) == 1


@pytest.mark.parametrize('failure,exit_code', [('process_deadline', -9), ('nonzero_exit', 1), (None, None)])
def test_incomplete_runner_cannot_report_success_from_its_partial_payload(tmp_path, monkeypatch, failure, exit_code):
    library, calls, _ = prepared(tmp_path, monkeypatch, [])
    monkeypatch.setattr('treadway.entra_robot.run_json_process', lambda *args, **kwargs:
                        {'payload': {'status': 'verified'}, 'failure': failure, 'exitCode': exit_code})
    with pytest.raises(AssertionError, match='entra_process_incomplete'):
        library.sign_in_with_entra('member')
    receipt = library.get_last_entra_result()
    assert receipt['observedResult']['status'] == 'verified'
    assert receipt['runner'] == {'failure': failure, 'exitCode': exit_code}
    assert len([call for call in calls if call[0] == 'start']) == 1


def test_missing_configuration_retains_first_attempt_and_safe_phase(tmp_path, monkeypatch):
    monkeypatch.setattr(BuiltIn, 'get_variable_value', lambda *args: str(tmp_path / 'output'))
    library = EntraLibrary(tmp_path / 'missing.json')
    with pytest.raises(AssertionError, match='configuration'):
        library.sign_in_with_entra('member')
    result = library.get_last_entra_result()
    assert result['phase'] == 'configuration'
    from pathlib import Path
    assert json.loads(Path(result['robotEvidence']).read_text())['code'] == 'configuration_incomplete'


def test_verified_reuse_does_not_resolve_password_provider(tmp_path, monkeypatch):
    library, _, _ = prepared(tmp_path, monkeypatch, [{'status': 'verified', 'reused': True}])
    monkeypatch.delenv('ENTRA_TEST_PASSWORD')
    result = library.sign_in_with_entra('member')
    assert result['reused'] is True


def test_private_credential_worker_resolves_only_on_explicit_invocation(tmp_path, monkeypatch):
    import subprocess
    import sys
    config = configuration(tmp_path)
    refs = json.loads(config.read_text())['credentials']
    monkeypatch.setenv('ENTRA_TEST_USERNAME', 'member@example.invalid')
    monkeypatch.setenv('ENTRA_TEST_PASSWORD', 'synthetic-worker-password')
    result = subprocess.run([sys.executable, '-m', 'treadway.entra_robot', '--resolve-credentials'],
                            input=json.dumps({'refs': refs, 'identity': 'member'}), text=True, capture_output=True, timeout=5)
    assert result.returncode == 0
    assert json.loads(result.stdout) == {'username': 'member@example.invalid', 'password': 'synthetic-worker-password'}
    assert not result.stderr
    monkeypatch.delenv('ENTRA_TEST_PASSWORD')
    result = subprocess.run([sys.executable, '-m', 'treadway.entra_robot', '--resolve-credentials'],
                            input=json.dumps({'refs': refs, 'identity': 'member'}), text=True, capture_output=True, timeout=5)
    assert result.returncode == 1
    assert json.loads(result.stdout) == {'error': 'credential_resolution_incomplete'}
    assert not result.stderr
