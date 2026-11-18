"""Installed Python state reuse and an exported Robot handoff on real Browserserve."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from treadway.authoring import main as author
from treadway.browser_runtime import BrowserRuntime
from treadway.browser_state import BrowserIdentity
from treadway.cdp import CdpSocket, CommandSession


def main():
    root = Path('/ev/python-acceptance')
    root.mkdir(mode=0o700)
    origin = sys.argv[1]
    config = {'provider': 'browserserve', 'binding': 'native-service',
              'endpoint_env': 'BROWSERSERVE_TEST_ENDPOINT', 'headers_env': 'BROWSERSERVE_PY_HEADERS'}
    os.environ['BROWSERSERVE_PY_HEADERS'] = json.dumps({'Authorization': 'Bearer '+os.environ['BROWSERSERVE_TOKEN']})
    principal = {'origin': origin, 'probe': '/principal', 'expected': {'principal': 'member'}}
    identity = BrowserIdentity(root/'identities', 'synthetic-member', 'workboard', 'member',
                               'native-service', (origin,), ('cookies', 'localStorage', 'sessionStorage'))
    project = root/'project'
    with BrowserRuntime(root/'initial', configuration=config, project_root=project) as browsers:
        member = browsers.acquire_identity('member', identity, principal=principal, restore=False)
        with browsers.drive(member):
            socket = CdpSocket(connection=member.connection())
            try:
                session = CommandSession(socket)
                session.command('Page.enable')
                session.command('Page.navigate', {'url': origin+'/?user=member'})
                deadline = time.monotonic()+10
                while not session.command('Runtime.evaluate', {'expression': 'location.origin === '+json.dumps(origin)+' && document.readyState === "complete"',
                                                               'returnByValue': True})['result']['value']:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('synthetic_navigation_incomplete')
                    time.sleep(.02)
                session.command('Runtime.evaluate', {'expression': 'localStorage.owner="member";sessionStorage.owner="member"', 'returnByValue': True})
            finally:
                socket.close()
        browsers.save_identity(member)
        assert member._identity_lease._record['execution']['provider'] == 'browserserve'
        assert browsers.release(member)['providerSessionClosed'] is True
    with BrowserRuntime(root/'restored', configuration=config, project_root=project) as browsers:
        member = browsers.acquire_identity('member', identity, principal=principal, landing_url=origin+'/')
        with browsers.drive(member):
            socket = CdpSocket(connection=member.connection())
            try:
                result = CommandSession(socket).command('Runtime.evaluate', {
                    'expression': '[localStorage.owner,sessionStorage.owner]', 'returnByValue': True})
                assert result['result']['value'] == ['member', 'member']
            finally:
                socket.close()
        assert browsers.release(member)['complete'] is True
    exported = root/'exported-flow'
    author(['new', str(exported)])
    config_file = root/'browser.json'
    config_file.write_text(json.dumps({'browser': config}))
    env = dict(os.environ, TREADWAY_PYTHON=sys.executable, FORM_ROBOT_PYTHON=sys.executable)
    result = subprocess.run([sys.executable, 'run.py', 'test', '--browser-config', str(config_file),
                             '--suite', 'handoff.robot', '--fixture-host', '127.0.0.1', '--fixture-port', '8765',
                             '--app-url', 'http://127.0.0.1:8765'], cwd=exported, env=env,
                            text=True, capture_output=True, timeout=75)
    (root/'robot-run.log').write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError('installed_robot_handoff_incomplete; inspect python-acceptance/robot-run.log')
    print(json.dumps({'installedPython': True, 'savedIdentityRestored': True, 'robotHandoff': True}))


if __name__ == '__main__':
    main()
