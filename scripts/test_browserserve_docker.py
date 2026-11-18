"""Run native adapter acceptance against an already-pulled immutable image.

Needs Docker, Node 22+, installed browser npm dependencies and the upstream
seccomp profile. Uses only an owned offline container and a synthetic local app.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import time

IMAGE = 'ghcr.io/browser-gateway/browserserve@sha256:c533e7b400e52802d08e53a6fa61f38b1f839d34cc0df10a3f56d3c48ae7251b'
SECCOMP_SHA256 = '71621cf097776a0b398676e3ac7f5471be8e0c666d343bf8592e79ef320fa9a3'
ROOT = Path(__file__).resolve().parents[1]


def public_summary(meta):
    """Only deliberately public fields; raw capabilities and logs stay private."""
    summary = {'image': IMAGE, 'passed': meta.get('passed') is True,
               'containerRemoved': meta.get('containerRemoved') is True}
    if type(meta.get('durationSeconds')) in {int, float}:
        summary['durationSeconds'] = meta['durationSeconds']
    pressure = meta.get('acceptance', {}).get('finalPressure', {})
    summary['finalSessions'] = {key: pressure[key] for key in ('running', 'parked')
                               if type(pressure.get(key)) is int}
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seccomp', type=Path, required=True)
    parser.add_argument('--docker-host')
    parser.add_argument('--browser-root', type=Path, default=ROOT/'src/treadway/browser')
    parser.add_argument('--python-executable', type=Path, help='Also verify an installed Python/Robot runtime')
    parser.add_argument('--output', type=Path, default=ROOT/'artifacts/browserserve-docker')
    args = parser.parse_args()
    profile = args.seccomp.resolve()
    if hashlib.sha256(profile.read_bytes()).hexdigest() != SECCOMP_SHA256:
        parser.error('Expected the pinned upstream seccomp profile; see docs/reference/BROWSERSERVE-ACCEPTANCE.md')
    node = Path(shutil.which('node') or '/missing-node').resolve()
    browser_root = args.browser_root.resolve()
    if not node.is_file() or not (browser_root/'browserserve.js').is_file():
        parser.error('Node and the built adapter must be available')
    docker = ['docker', *(['--host', args.docker_host] if args.docker_host else [])]
    output = args.output.absolute()/secrets.token_hex(8)
    output.mkdir(parents=True, mode=0o700)
    output.chmod(0o700)
    name = 'tw-bs-acceptance-'+secrets.token_hex(8)
    token = secrets.token_hex(32)
    env = dict(os.environ, BROWSERSERVE_TOKEN=token)
    python_executable = args.python_executable.absolute() if args.python_executable else None
    meta = {'image': IMAGE, 'container': name, 'passed': False, 'startedAt': time.time(),
            'sandboxRequired': True, 'network': 'none', 'seccompSha256': SECCOMP_SHA256}

    def run(command, timeout=30, binary=False):
        return subprocess.run(docker+command, env=env, capture_output=True, text=not binary, timeout=timeout)

    def require(command, timeout=30):
        result = run(command, timeout)
        if result.returncode:
            save('docker-'+command[0]+'-error.log', result.stderr)
            raise RuntimeError('Docker '+command[0]+' failed; inspect private evidence')
        return result.stdout

    def save(name, content):
        path = output/name
        path.write_text(content.replace(token, '<redacted>'))
        path.chmod(0o600)

    def export():
        archive = run(['exec', name, 'tar', '-C', '/ev', '-cf', '-', '.'], binary=True)
        if archive.returncode:
            raise RuntimeError('evidence_export_incomplete')
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as source:
            source.extractall(output/'evidence', filter='data')
        meta['evidenceExported'] = True

    created = False
    try:
        image = json.loads(require(['image', 'inspect', IMAGE]))[0]
        meta.update(imageId=image['Id'], sourceRevision=(image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision'))
        config = output/'service.yml'
        config.write_text('pressure:\n  maxCpuPercent: 100\n  maxMemoryPercent: 100\n')
        config.chmod(0o644)  # Synthetic admission settings; readable by runtime uid999.
        command = ['run', '--pull=never', '--detach', '--name', name, '--network', 'none', '--shm-size', '1g',
                   '--security-opt', 'seccomp='+str(profile)]
        for directory in ['/home/runtime', '/var/lib/browserserve', '/ev']:
            command += ['--tmpfs', directory+':rw,uid=999,gid=999,mode=700']
        command += ['--tmpfs', '/tmp:rw,mode=1777']
        mounts = {(ROOT, str(ROOT)), (node, str(node)), (browser_root, str(browser_root)),
                  (config, '/tmp/service.yml')}
        if python_executable:
            observed = json.loads(subprocess.check_output([str(python_executable), '-c',
                'import json,sys,sysconfig;print(json.dumps([sys.prefix,sys._base_executable,sysconfig.get_path("stdlib")]))'], text=True))
            for directory in observed:
                source = Path(directory).resolve()
                mounts.add((source, str(source)))
                mounts.add((source, str(Path(directory).absolute())))
        for key in ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS']:
            if env.get(key) and Path(env[key]).is_file():
                mounts.add((Path(env[key]).resolve(), env[key]))
        for source, target in sorted(mounts):
            command += ['--mount', f'type=bind,source={source},target={target},readonly']
        for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'BROWSERSERVE_TOKEN']:
            if key in env:
                command += ['--env', key]
        settings = {'HOST': '127.0.0.1', 'PORT': '9222', 'BROWSERSERVE_CONFIG': '/tmp/service.yml',
                    'BROWSERSERVE_REQUIRE_SANDBOX': '1', 'BROWSERSERVE_NO_SANDBOX': '0',
                    'BROWSERSERVE_STEALTH': '0', 'BROWSERSERVE_MIN_READY': '0', 'BROWSERSERVE_MAX_SESSIONS': '3',
                    'BROWSERSERVE_MAX_QUEUE': '0', 'BROWSERSERVE_CALIBRATE': '0',
                    'BROWSERSERVE_RESUME_WINDOW_MS': '5000', 'BROWSERSERVE_IDLE_TIMEOUT_MS': '0'}
        for key, value in settings.items():
            command += ['--env', key+'='+value]
        meta['settings'] = settings
        require(command+[IMAGE], timeout=180)
        created = True
        meta['binaryVersion'] = require(['exec', name, 'browserserve', '--version']).strip()
        meta['runtimeUid'] = require(['exec', '--user', '999:999', name, 'id']).strip()
        test = run(['exec', '--user', '999:999', '--env', 'PATH='+str(node.parent)+':/usr/local/bin:/usr/bin:/bin',
                    *(['--env', 'TREADWAY_SERVICE_PYTHON='+str(python_executable)] if python_executable else []),
                    '--env', 'BROWSERSERVE_TEST_ENDPOINT=ws://127.0.0.1:9222/',
                    '--env', 'BROWSERSERVE_EVIDENCE_ROOT=/ev', '--env', 'FORM_BROWSER_MODULE_ROOT='+str(browser_root),
                    name, str(node), '--test', str(ROOT/'tests/test_browserserve_service.js')], timeout=210)
        save('test.log', test.stdout+test.stderr)
        export()
        results = list((output/'evidence').glob('tw-bs-adapter-*/result.json'))
        if test.returncode == 0 and len(results) == 1:
            result = json.loads(results[0].read_text())
            meta.update(passed=result['passed'], acceptance=result)
    except Exception as error:
        meta['errorType'] = type(error).__name__
    finally:
        # A timed-out `docker run` can leave an owned container even if its CLI
        # never returned an ID. Discover only the unpredictable name we generated.
        if not created:
            try:
                created = run(['inspect', name]).returncode == 0
            except Exception as error:
                # Creation may have reached the daemon despite observation loss.
                created = True
                meta['cleanupInspectionError'] = type(error).__name__
        if created:
            if not meta.get('evidenceExported'):
                try:
                    export()
                except Exception as error:
                    meta['evidenceExportError'] = type(error).__name__
            try:
                logs = run(['logs', '--timestamps', name])
                save('service.log', logs.stdout+logs.stderr)
            except Exception as error:
                meta['serviceLogError'] = type(error).__name__
            try:
                meta['containerStopAcknowledged'] = run(['stop', '--time', '8', name], timeout=20).returncode == 0
            except Exception as error:
                meta['containerStopError'] = type(error).__name__
            try:
                meta['containerRemoved'] = run(['rm', '--force', name], timeout=30).returncode == 0
            except Exception as error:
                meta['containerRemovalError'] = type(error).__name__
                meta['containerRemoved'] = False
            meta['passed'] = meta['passed'] and meta['containerRemoved']
        meta['durationSeconds'] = round(time.time()-meta['startedAt'], 3)
        save('result.json', json.dumps(meta, indent=2)+'\n')
        save('ci-summary.json', json.dumps(public_summary(meta), indent=2)+'\n')
    print(json.dumps({'passed': meta['passed'], 'evidence': str(output), 'containerRemoved': meta.get('containerRemoved')}))
    return 0 if meta['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
