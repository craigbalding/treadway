"""Real Robot TRACE output must not disclose resolved secrets or failures."""
import json
import subprocess
import sys

from robot.api.types import Secret

from treadway.credentials_robot import CredentialLibrary


def test_library_import_and_construction_are_passive(tmp_path):
    library = CredentialLibrary(tmp_path/'nonexistent-config.json')
    assert library._resolver is None


def test_robot_native_secrets_cross_keywords_without_disclosure_at_trace(tmp_path, monkeypatch):
    secret = 'synthetic-sensitive-robot-canary'
    monkeypatch.setenv('ROBOT_CREDENTIAL_FIXTURE', secret)
    config = {'providers': {'env': {'type': 'environment'}}, 'identities': {'reviewer': {
        'expected': {'principal': 'user-b'},
        'credentials': {'password': {'provider': 'env', 'name': 'ROBOT_CREDENTIAL_FIXTURE'}}}}}
    (tmp_path/'identities.json').write_text(json.dumps(config))
    (tmp_path/'login_recipe.py').write_text(
        'from robot.api.types import Secret\n'
        'def receive_credential(password: Secret):\n'
        ' assert isinstance(password,Secret)\n'
        ' assert password.value == __import__("os").environ["ROBOT_CREDENTIAL_FIXTURE"]\n'
        ' return True\n')
    suite = tmp_path/'credentials.robot'
    suite.write_text('*** Settings ***\n'
        'Library    treadway.credentials_robot.CredentialLibrary    ${CURDIR}/identities.json\n'
        'Library    login_recipe\n'
        '*** Test Cases ***\nSecret Handling\n'
        '    ${password}=    Get Credential    reviewer    password\n'
        '    Log    ${password}\n'
        '    Receive Credential    ${password}\n'
        '    Run Keyword And Expect Error    *Secret*    Receive Credential    plain-synthetic-input\n'
        '    Run Keyword And Expect Error    *credential_unavailable*    Get Credential    missing    password\n')
    result = subprocess.run([sys.executable, '-m', 'robot', '--pythonpath', str(tmp_path),
                             '--loglevel', 'TRACE', '--outputdir', str(tmp_path/'results'), str(suite)],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout+result.stderr
    assert secret not in result.stdout+result.stderr
    for file in (tmp_path/'results').iterdir():
        assert secret.encode() not in file.read_bytes(), file
    value = CredentialLibrary(tmp_path/'identities.json').get_credential('reviewer', 'password')
    assert isinstance(value, Secret) and value.value == secret


def test_real_robot_dry_run_does_not_open_missing_configuration(tmp_path):
    suite = tmp_path/'passive.robot'
    suite.write_text('*** Settings ***\nLibrary    treadway.credentials_robot.CredentialLibrary    /nonexistent/passive.json\n'
                     '*** Test Cases ***\nPassive\n    Get Credential    reviewer    password\n')
    result = subprocess.run([sys.executable, '-m', 'robot', '--dryrun', '--outputdir', str(tmp_path/'results'), str(suite)],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout+result.stderr


def test_provider_failure_keeps_subprocess_output_out_of_robot_trace(tmp_path):
    secret = 'synthetic-provider-failure-canary'
    executable = tmp_path/'synthetic-op'
    executable.write_text('#!'+sys.executable+'\nimport sys\n'
                          f'print({secret!r});print({secret!r},file=sys.stderr);sys.exit(1)\n')
    executable.chmod(0o700)
    (tmp_path/'identities.json').write_text(json.dumps({
        'providers': {'op': {'type': '1password', 'executable': str(executable)}},
        'identities': {'reviewer': {'expected': {'principal': 'b'}, 'credentials': {
            'password': {'provider': 'op', 'name': 'op://synthetic/reviewer/password'}}}}}))
    suite = tmp_path/'failure.robot'
    suite.write_text('*** Settings ***\n'
        'Library    treadway.credentials_robot.CredentialLibrary    ${CURDIR}/identities.json\n'
        '*** Test Cases ***\nProvider Failure\n    Get Credential    reviewer    password\n')
    result = subprocess.run([sys.executable, '-m', 'robot', '--loglevel', 'TRACE',
                             '--outputdir', str(tmp_path/'results'), str(suite)],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 1
    assert 'credential_unavailable' in result.stdout
    assert secret not in result.stdout+result.stderr
    for file in (tmp_path/'results').iterdir():
        assert secret.encode() not in file.read_bytes(), file
