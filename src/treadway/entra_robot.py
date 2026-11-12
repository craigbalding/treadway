"""Native Robot entry point for the shared, optional Entra browser recipe."""
import hashlib
import json
from pathlib import Path
import sys
import uuid

from robot.api import logger
from robot.api.deco import keyword

from .browsers import BrowserManager, private_json
from .credentials import CredentialResolver
from .process import run_json_process


class EntraLibrary:
    ROBOT_LIBRARY_SCOPE = 'SUITE'
    ROBOT_AUTO_KEYWORDS = False

    def __init__(self, configuration):
        # Imports/dry-runs do not read configuration, resolve secrets or start Chrome.
        self.configuration = configuration
        self.last_result = None

    @keyword
    def get_last_entra_result(self):
        return self.last_result

    @keyword
    def sign_in_with_entra(self, identity):
        """Run one bounded login, detecting MFA challenge/setup automatically.

        The explicit keyword invocation permits one password and MFA submission.
        It never retries a login. The profile is stable for this configuration,
        application and identity; another identity gets a separate profile.
        """
        from robot.libraries.BuiltIn import BuiltIn
        self.last_result = None
        output = Path(BuiltIn().get_variable_value('${OUTPUT DIR}', str(Path.home() / '.local/state/treadway/attempts')))
        attempt = output / 'treadway' / str(uuid.uuid4())
        attempt.mkdir(parents=True, mode=0o700)
        attempt.chmod(0o700)
        session = None
        owned = False
        receipt = None
        browser_evidence = None
        phase = 'configuration'
        phases = []

        def enter(next_phase):
            nonlocal phase
            phase = next_phase
            phases.append(phase)
            private_json(attempt / f'{len(phases):02d}-{phase}.json', {'phase': phase, 'state': 'started'})

        try:
            enter('configuration')
            config_path = Path(self.configuration).expanduser().resolve()
            config = json.loads(config_path.read_text())
            refs = (config_path.parent / config['credentials']).resolve()
            enter('identity_configuration')
            source = CredentialResolver.from_file(refs)
            actor = source.identity(identity)
            options = config['application']
            key = json.dumps([str(refs), config.get('scope', ''), options['origin'], identity])
            binding = hashlib.sha256(key.encode()).hexdigest()[:32]
            root = Path(config['browser']['root']).expanduser().resolve()
            manager = BrowserManager(root, verification_seconds=config['browser'].get('verification_seconds', 2))
            existing = config['browser'].get('existing_session')
            name = existing or 'entra-' + binding
            # This reference also survives startup failure, when no handle exists.
            browser_evidence = {'name': name, 'directory': str(root / name)}
            enter('browser_attach' if existing else 'browser_start')
            if existing:
                session = manager.attach(existing)
                if config['browser'].get('generation') != session.generation:
                    raise RuntimeError('explicit_current_browser_generation_required')
            else:
                session = manager.start('entra-' + binding, executable=config['browser']['executable'],
                                        persistent=True, require_new=True)
                owned = True
            enter('flow_configuration')
            payload = {'connection': {'cdpHost': '127.0.0.1', 'cdpPort': session.port, 'targetId': session.target_id},
                       'credentialSource': {'python': sys.executable, 'refs': str(refs), 'identity': identity},
                       'allowSubmission': True,
                       'totpRoot': str(root / 'totp' / binding),
                       'options': {'appOrigin': options['origin'], 'signinUrl': options.get('signin_url', options['origin']),
                                   'idpOrigins': options.get('idp_origins', ['https://login.microsoftonline.com', 'https://mysignins.microsoft.com']),
                                   'principal': {'actor': identity, 'generation': session.generation,
                                                 'probe': options['principal_probe'], 'expected': dict(actor.expected),
                                                 'timeoutMs': options.get('principal_timeout_ms', 5000)},
                                   'evidenceRoot': str(attempt),
                                   'exportCookies': config.get('export_cookies', True),
                                   'screenshotMask': config.get('screenshot_mask', 'none')}}
            with manager.drive(session):
                enter('flow')
                result = run_json_process(['node', str(Path(__file__).with_name('browser') / 'entra-runner.js')],
                                          input_data=json.dumps(payload), timeout_seconds=285)
            receipt = result.get('payload')
            if not isinstance(receipt, dict):
                receipt = {'status': 'entra_process_incomplete', 'outcome': 'unknown'}
            if result.get('failure') is not None or result.get('exitCode') != 0:
                transport = {'failure': result.get('failure'), 'exitCode': result.get('exitCode')}
                if receipt.get('status') == 'verified':
                    receipt = {'status': 'entra_process_incomplete', 'outcome': 'unknown', 'observedResult': receipt,
                               'nextStep': 'The runner did not complete. Reconcile its recorded authentication observation before another login.'}
                receipt['runner'] = transport
            receipt['browser'] = {'name': session.name, 'generation': session.generation, 'persistent': session.persistent}
        except Exception as error:
            receipt = {'status': 'entra_setup_incomplete', 'outcome': 'unknown', 'phase': phase,
                       'code': phase + '_incomplete', 'errorType': type(error).__name__,
                       'nextStep': f'Inspect the retained {phase} evidence and browser logs before another attempt. No automatic retry was made.'}
        finally:
            if owned and session is not None:
                cleanup = {'complete': True}
                try:
                    manager.stop(session)
                except (OSError, RuntimeError, ValueError):
                    cleanup = {'complete': False}
                if receipt is not None:
                    receipt['cleanup'] = cleanup
        receipt['phases'] = phases
        receipt.setdefault('authentication', {'state': 'unknown'})
        if browser_evidence:
            receipt['browserEvidence'] = browser_evidence
        receipt['robotEvidence'] = str(attempt / 'receipt.json')
        private_json(attempt / 'receipt.json', receipt)
        self.last_result = receipt
        logger.info(json.dumps(receipt))
        if receipt.get('status') != 'verified':
            raise AssertionError(f"Entra {receipt.get('status')}: {receipt.get('nextStep', 'inspect the retained attempt evidence')}")
        if receipt.get('cleanup', {}).get('complete') is False:
            raise AssertionError('Entra authentication verified; browser cleanup incomplete. Resolve cleanup without another login.')
        return receipt


def _credential_worker(refs, identity):
    """Private subprocess output, invoked lazily only after reuse is unavailable."""
    try:
        source = CredentialResolver.from_file(refs)
        actor = source.identity(identity)
        result = {'username': source.read(identity, 'username'), 'password': source.read(identity, 'password')}
        if 'totp_secret' in actor.credentials:
            result['totpSecret'] = source.read(identity, 'totp_secret')
        sys.stdout.write(json.dumps(result))
        return 0
    except Exception:
        sys.stdout.write('{"error":"credential_resolution_incomplete"}')
        return 1


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] != '--resolve-credentials':
        raise SystemExit('explicit_credential_worker_arguments_required')
    try:
        request = json.load(sys.stdin)
        status = _credential_worker(request['refs'], request['identity'])
    except Exception:
        sys.stdout.write('{"error":"credential_resolution_incomplete"}')
        status = 1
    raise SystemExit(status)
