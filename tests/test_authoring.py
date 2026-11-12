"""Consumer exports must work without checkout paths or live side effects."""
from pathlib import Path
import os
import subprocess
import sys

import pytest

from treadway.authoring import ASSETS, copy_new, main


def test_export_refuses_existing_destination_and_symlink(tmp_path):
    existing = tmp_path / 'existing'
    existing.mkdir()
    sentinel = existing / 'keep.txt'
    sentinel.write_text('user content')
    with pytest.raises(ValueError, match='already exists'):
        copy_new(ASSETS / 'project', existing)
    link = tmp_path / 'link'
    link.symlink_to(existing, target_is_directory=True)
    with pytest.raises(ValueError, match='already exists'):
        copy_new(ASSETS / 'project', link)
    assert sentinel.read_text() == 'user content'
    assert sorted(existing.iterdir()) == [sentinel]


def test_new_project_exports_self_contained_skill_and_checks_without_browser(tmp_path, monkeypatch):
    project = tmp_path / 'flow with spaces'
    main(['new', str(project)])
    assert (project / '.gitignore').is_file()
    skill = project / '.agents/skills/treadway-flows'
    for reference in ['SKILL.md', 'references/AUTHORING.md', 'references/RECIPES.md', 'references/WALKTHROUGH.md']:
        assert (skill / reference).is_file()
    monkeypatch.delenv('CHROME_BIN', raising=False)
    monkeypatch.setenv('TREADWAY_REFERENCE_CONFIG', '/does-not-exist/passive-constructor-canary')
    result = subprocess.run([sys.executable, 'run.py', 'check'], cwd=project,
                            capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stdout + result.stderr
    import json
    summary = json.loads(result.stdout.splitlines()[-1])
    assert summary['passed'] is True
    assert summary['liveConditionsVerified'] is False
    assert len(summary['checks']) == 5
    assert not list(project.rglob('DevToolsActivePort'))
    assert not list(project.rglob('*.sqlite'))


def test_skill_can_be_exported_independently(tmp_path):
    skill = tmp_path / 'agent-skills/treadway-flows'
    main(['skill', str(skill)])
    assert (skill / 'SKILL.md').read_text().startswith('---\nname: treadway-flows\n')
    assert (skill / 'references/AUTHORING.md').is_file()
    with pytest.raises(SystemExit) as error:
        main(['skill', str(skill)])
    assert error.value.code == 1


@pytest.mark.parametrize('topic,content', [('start', 'Adapt another application'),
                                           ('recipes', 'run_json_process'),
                                           ('walkthrough', 'Hand the same item'),
                                           ('sessions', 'A profile label is not a principal'),
                                           ('credentials', 'Credentials and optional vaults'),
                                           ('entra', 'Sign in with Microsoft Entra')])
def test_installed_reference_is_accessible(capsys, topic, content):
    main(['guide', topic])
    assert content in capsys.readouterr().out


def test_check_deadline_stops_a_hung_contract_without_starting_browser(tmp_path):
    import json
    import os
    import time
    project = tmp_path / 'bounded'
    main(['new', str(project)])
    (project / 'tests/test_hung_contract.py').write_text(
        'import os,time,unittest\nfrom pathlib import Path\n'
        'class Hung(unittest.TestCase):\n'
        ' def test_hang(self):\n'
        '  Path("contract.pid").write_text(str(os.getpid()))\n'
        '  time.sleep(60)\n')
    started = time.monotonic()
    result = subprocess.run([sys.executable, 'run.py', 'check', '--budget-seconds', '5'],
                            cwd=project, capture_output=True, text=True, timeout=10)
    assert result.returncode == 1
    assert time.monotonic() - started < 8
    summary = json.loads(result.stdout.splitlines()[-1])
    assert summary['passed'] is False
    assert summary['liveConditionsVerified'] is False
    assert not list(project.rglob('*.sqlite'))
    assert not list(project.rglob('DevToolsActivePort'))
    pid_file = project / 'contract.pid'
    assert pid_file.is_file(), result.stdout
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_failed_contract_retains_completed_checks_and_its_own_log(tmp_path):
    import json
    project = tmp_path / 'failed-contract'
    main(['new', str(project)])
    (project / 'tests/new_mapping.test.cjs').write_text(
        "const {test}=require('node:test');test('deliberate broken mapping',()=>{throw new Error('mapping differs');});\n")
    result = subprocess.run([sys.executable, 'run.py', 'check'], cwd=project,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 1
    summary = json.loads(result.stdout.splitlines()[-1])
    assert summary['passed'] is False
    assert [entry['name'] for entry in summary['checks']] == ['python-syntax', 'python-contracts', 'adapter-contracts']
    assert all(entry['passed'] for entry in summary['checks'][:2])
    failed = summary['checks'][-1]
    assert failed['passed'] is False
    assert failed['status'] == 'failed'
    assert failed['exitCode'] != 0
    assert 'mapping differs' in Path(failed['log']).read_text()


@pytest.mark.skipif(not os.environ.get('CHROME_BIN'), reason='CHROME_BIN required')
def test_feedback_timeout_stops_actor_browsers_even_without_robot_teardown(tmp_path):
    import json
    from treadway.browsers import BrowserManager, BrowserSession
    project = tmp_path/'deadline-project'
    main(['new', str(project)])
    (project/'deadline.robot').write_text(
        '*** Settings ***\nLibrary    collaborative_flow.CollaborativeFlow\n'
        'Library    OperatingSystem\nTest Setup    Open Collaborative Run\n'
        'Test Teardown    Close Collaborative Run\n*** Test Cases ***\n'
        'Interrupted Collaboration\n    Open Actor    author\n'
        '    Create File    ${CURDIR}/actor-opened\n    Sleep    60\n')
    # Exercise the actual browser runner's interrupted-Robot cleanup directly.
    # Repeating five offline gates here can consume the observation budget
    # before the actor exists, which tests startup speed instead of cleanup.
    driver = (
        'import json,subprocess,time\nfrom pathlib import Path\nimport run\n'
        'output=Path("artifacts/test-deadline");output.mkdir(parents=True)\nchecks=[]\n'
        'try:\n'
        ' run.browser_test(output.resolve(),time.monotonic()+20,[Path("deadline.robot").resolve()],checks)\n'
        'except subprocess.TimeoutExpired:\n'
        ' print(json.dumps({"passed":False,"timedOut":True,"checks":checks,"artifacts":str(output.resolve())}))\n'
        ' raise SystemExit(1)\n'
        'raise SystemExit("Expected the browser-flow deadline")\n'
    )
    try:
        result = subprocess.run([sys.executable, '-c', driver],
                                cwd=project, capture_output=True, text=True, timeout=32)
        assert result.returncode == 1, result.stdout+result.stderr
        summary = json.loads(result.stdout.splitlines()[-1])
        assert summary['passed'] is False
        assert summary['timedOut'] is True
        output = Path(summary['artifacts'])
        assert json.loads((output/'browser-cleanup.json').read_text())['complete'] is True
        assert summary['checks'][-1]['status'] == 'incomplete'
        for directory in ('browsers', 'actors'):
            sessions = BrowserManager(output/directory).sessions()
            assert sessions and all(not entry['running'] for entry in sessions)
            # A ready owned actor is the resource this regression must recover.
            # Its later app-principal probe need not finish before interruption.
            assert all(entry['phase'] == 'ready' and entry['session']['target_id'] for entry in sessions)
    finally:
        # Keep a future failing regression from leaking its own test browsers.
        # This runs after assertions, so it cannot make broken runner cleanup pass.
        for output in (project/'artifacts').glob('test-*'):
            for name in ('browsers', 'actors'):
                owner = BrowserManager(output/name)
                for entry in owner.sessions():
                    if entry['running']:
                        owner.stop(BrowserSession(**entry['session']))
