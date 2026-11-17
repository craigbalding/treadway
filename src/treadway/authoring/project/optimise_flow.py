"""Optimise a proven synthetic flow for the operator's objective and assurance.

Default execution uses HTTP for persisted ownership; validation retains its UI.
--benchmark explicitly measures baseline and candidate on separate transactions.
No application or browser starts on import, construction, --help or --describe.
"""
import argparse
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import os
import platform
import sqlite3
from pathlib import Path
import time
import subprocess
import uuid

from treadway.browser_runtime import BrowserRuntime
from treadway.diagnostics import RunDiagnostics, reference
from treadway.optimisation import compare_objective_runs, fingerprint, summarise_profile
from treadway.process import run_json_process
from treadway.recovery import OperationIncomplete
import treadway

from optimisation_fixture import ACTORS, OwnerFixture


HERE = Path(__file__).resolve().parent
ENVIRONMENT = 'owner-fixture-v1'
TIMING = ['fixture_setup', 'authentication', 'browser_start_if_used', 'execution', 'checks', 'owned_teardown', 'diagnostics']


class BrowserIncomplete(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__('browser_step_incomplete; original effect must be observed')


def private_json(path, value, *, exclusive=False):
    """Persist consumer evidence before proceeding; never a best-effort log."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path if exclusive else path.with_name('.'+path.name+'-'+uuid.uuid4().hex)
    with temporary.open('x', encoding='utf8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def testing_objective(name, count, modes=('cold',)):
    if name not in {'persistence', 'validation'} or not 1 <= count <= 100:
        raise ValueError('supported_synthetic_objective_required')
    boundary = 'application' if name == 'persistence' else 'browser'
    return {'version': 'treadway.objective/1', 'id': name,
            'question': 'Assign each bound item to the new owner and verify persistence.' if name == 'persistence' else 'Does the editor reject an unknown owner?',
            'mutation': name == 'persistence', 'modes': list(modes),
            'conditions': {'authentication': 'authenticated', 'renewal': 'allowed',
                           'owner_input': 'valid' if name == 'persistence' else 'intentionally-invalid'},
            'obligations': [{'id': 'requesting-principal', 'boundary': 'session'},
                            {'id': 'tested-behaviour', 'boundary': boundary},
                            {'id': 'persisted-state', 'boundary': 'persistence'}],
            'workload': [{'id': f'item-{i}', 'actor': ACTORS[(i-1) % 2], 'resource_slot': f'item-{i}',
                          'values': {'revision': 1, 'owner': 'owner-b' if name == 'persistence' else 'unknown-owner'}}
                         for i in range(1, count+1)],
            'required_challenges': ['wrong-actor', 'swapped-resource', 'stale-revision', 'contract-drift', 'missing-evidence']
                                   + (['lost-response'] if name == 'persistence' else [])}


def disposition(name):
    """Analysis only: native functions below perform the actual execution."""
    return [
        {'stage': 'establish-session', 'decision': 'retain', 'fresh_check': 'actual requesting principal',
         'knowledge': 'session-and-principal-contract'},
        {'stage': 'find-open-item', 'decision': 'omit-list-navigation',
         'knowledge': 'supplied item binding and calibrated route',
         'fresh_check': 'original resource, creator and revision'},
        {'stage': 'edit-owner', 'decision': 'construct-bound-payload' if name == 'persistence' else 'retain-browser-input',
         'knowledge': 'owner payload mapping' if name == 'persistence' else 'browser validation is under test',
         'fresh_check': 'preserve supplied owner value without repair'},
        {'stage': 'submit-observe', 'decision': 'journalled-http-and-readback' if name == 'persistence' else 'retain-browser-validation',
         'knowledge': 'calibrated write and independent SQLite observer',
         'fresh_check': 'persisted owner/revision/write count' if name == 'persistence' else 'actual UI refusal and zero writes'}]


class Context:
    def __init__(self, root, count, *, expire_after=None, lose_response=None,
                 browser_config=None, browser_app_url=None, fixture_host='127.0.0.1'):
        self.root = Path(root)
        self.fixture = OwnerFixture(self.root/'application', count, expire_after=expire_after, lose_response=lose_response,
                                   browser_app_url=browser_app_url, fixture_host=fixture_host)
        self.executors, self.browsers = {}, {}
        self.browser_config, self.browser_app_url = browser_config, browser_app_url
        self.manager = BrowserRuntime.from_file(browser_config, root=self.root/'browsers', project_root=HERE) if browser_config else BrowserRuntime(
            self.root/'browsers', project_root=HERE)

    def start(self):
        self.fixture.start()
        return self

    def executor(self, actor):
        if actor not in self.executors:
            self.executors[actor] = self.fixture.executor(actor, self.root/actor)
        return self.executors[actor]

    def browser(self, actor):
        if actor not in self.browsers:
            if self.manager.provider != 'local' and not self.browser_app_url:
                raise ValueError('remote_browser_requires_reachable_fixture_url')
            options = {'executable': os.environ['CHROME_BIN'], 'sandbox': True} if self.manager.provider == 'local' else {}
            self.browsers[actor] = self.manager.acquire(actor, **options)
        return self.browsers[actor]

    def browser_call(self, actor, run, directory, **binding):
        browser = self.browser(actor)
        config = {'browserRoot': str(Path(treadway.__file__).parent/'browser'),
                  'origin': self.fixture.browser_origin,
                  'actor': actor, 'generation': browser.generation, 'journal': str(directory/'browser.jsonl'),
                  'diagnostics': run.bridge() if run else None, **binding}
        with self.manager.drive(browser):
            config['connection'] = browser.connection()
            transport = run_json_process(['node', str(HERE/'optimisation_browser.cjs')],
                input_data=json.dumps(config), timeout_seconds=25)
        private_json(directory/('browser-transport-'+uuid.uuid4().hex+'.json'), transport)
        payload = transport.get('payload')
        if (transport['failure'] or transport['exitCode'] != 0 or not isinstance(payload, dict)
                or payload.get('complete') is not True):
            raise BrowserIncomplete(payload.get('error') if isinstance(payload, dict) else 'missing_result')
        return payload['result']

    def prewarm(self, objective, transport):
        for actor in {binding['actor'] for binding in objective['workload']}:
            if transport == 'http':
                self.executor(actor)
            else:
                self.browser_call(actor, None, self.root, operation='session')

    def close(self):
        errors = []
        try:
            try:
                if not self.manager.close()['complete']:
                    errors.append('cleanup_incomplete')
            except (RuntimeError, OSError) as error:
                errors.append(type(error).__name__)
        finally:
            self.fixture.close()
        if errors:
            raise RuntimeError('owned_browser_cleanup_incomplete')


def http_binding(context, binding, operation_id, run, links):
    executor = context.executor(binding['actor'])
    links[reference(operation_id)] = 'save-owner'
    try:
        receipt = executor.execute(operation_id, '/items/'+binding['item'], method='PATCH',
            body={'id': binding['item'], **binding['values']}, binding={'id': binding['item'], 'creator': binding['actor']},
            headers={'If-Match': str(binding['values']['revision'])})
    except OperationIncomplete as error:
        receipt = error.receipt
    receipt['intent_digest'] = fingerprint(executor.read_evidence(operation_id)['intent'])
    # Core verified the actual HTTP principal before dispatch. The fixture audit
    # additionally binds the committed write to that principal, even when its
    # response was lost or the session expired immediately after commit.
    return receipt, {'principal': context.fixture.mutation_actor(binding['item']),
                     'owner': binding['values']['owner'] if receipt['state'] == 'confirmed' else None}


def browser_binding(context, binding, operation_id, run, directory, *, direct, objective):
    intent = {'operation_id': operation_id, 'actor': binding['actor'], 'item': binding['item'], 'values': binding['values']}
    # The consumer reserves once before invoking the browser. Reentry never submits.
    reservation = directory/(operation_id+'-intent.json')
    if reservation.exists():
        if json.loads(reservation.read_text()) != intent:
            raise ValueError('original_browser_intent_differs')
        raise RuntimeError('browser_operation_already_reserved; reconcile_original_only')
    private_json(reservation, intent, exclusive=True)
    try:
        result = context.browser_call(binding['actor'], run, directory, item=binding['item'],
            revision=binding['values']['revision'], owner=binding['values']['owner'], objective=objective, direct=direct)
    except BrowserIncomplete as error:
        result = {'incomplete_code': error.code}
    actual = context.fixture.observe(binding['item'])
    confirmed = actual == {'id': binding['item'], 'creator': binding['actor'], 'owner': binding['values']['owner'],
                           'revision': binding['values']['revision']+1, 'writes': 1}
    validation = objective == 'validation' and result.get('validation') == 'Unknown owner' and actual['writes'] == 0
    if confirmed:
        result.update(principal=context.fixture.mutation_actor(binding['item']), owner=actual['owner'])
    receipt = {'operation_id': operation_id, 'state': 'confirmed' if confirmed else 'not_dispatched' if validation else 'unknown',
               'cached': False, 'unresolved_effect': not (confirmed or validation),
               'dispatches': 1 if confirmed else 0 if validation else 1, 'intent_digest': fingerprint(intent)}
    return receipt, result


def run_sample(root, objective, variant, mode, pair, challenge, *, context=None, offset=0,
               expire_after=None, lose_response=None, browser_options=None):
    directory = Path(root)/uuid.uuid4().hex
    directory.mkdir(parents=True, mode=0o700)
    run_id, owned = directory.name, context is None
    transport = 'http' if variant == 'candidate' and objective['id'] == 'persistence' else 'browser'
    context = context or Context(directory/'context', len(objective['workload']),
                                 expire_after=expire_after, lose_response=lose_response, **(browser_options or {}))
    record = {'version': 'treadway.objective-run/1', 'id': run_id, 'objective_digest': fingerprint(objective),
              'workload_digest': fingerprint(objective['workload']), 'conditions': objective['conditions'],
              'variant': variant, 'pair': pair, 'mode': mode, 'environment': ENVIRONMENT,
              'implementation_digest': implementation_digest(context.browser_config), 'transaction_scope': run_id,
              'subject': transport if transport == 'http' else 'browser-direct' if variant == 'candidate' else 'browser-list',
              'faults': {'expire_after': context.fixture.expire_after, 'lose_response': context.fixture.lose_response},
              'observations': [], 'transactions': [], 'challenges': [], 'binding_durations_ms': [], 'outcome': 'incomplete'}
    links, failure = {}, None
    started = time.monotonic()
    diagnostics = RunDiagnostics(directory/'diagnostics', level='DEBUG',
        watch=[HERE/'optimise_flow.py', HERE/'optimisation_fixture.py', HERE/'optimisation_browser.cjs'], watch_runtime=True)
    try:
        with diagnostics:
            try:
                if owned:
                    context.start()
                initial = {key: context.fixture.state[key] for key in ('writes', 'refreshes', 'lost')}
                for source in objective['workload']:
                    tick = time.monotonic()
                    binding = {**source, 'item': f'item-{offset+int(source["id"].split("-")[-1])}'}
                    operation_id = run_id+'-'+source['id']
                    if transport == 'http':
                        receipt, observed = http_binding(context, binding, operation_id, diagnostics, links)
                    else:
                        receipt, observed = browser_binding(context, binding, operation_id, diagnostics, directory,
                            direct=variant == 'candidate', objective=objective['id'])
                    receipt_ref = private_json(directory/(operation_id+'-receipt.json'), {
                        'version': 'treadway.transaction-evidence/1', 'run_id': run_id,
                        'binding': source['id'], 'scope': run_id, 'intent_digest': receipt['intent_digest'], 'receipt': receipt})
                    record['transactions'].append({'binding': source['id'], 'scope': run_id,
                        'operation_id': operation_id, 'intent_digest': receipt['intent_digest'], 'evidence': receipt_ref})
                    actual = context.fixture.observe(binding['item'])
                    persisted = (actual == {'id': binding['item'], 'creator': binding['actor'], 'owner': binding['values']['owner'],
                                           'revision': 2, 'writes': 1}) if objective['id'] == 'persistence' else (
                                               actual['owner'] == 'owner-a' and actual['revision'] == 1 and actual['writes'] == 0)
                    behaviour = observed.get('owner') == binding['values']['owner'] and receipt['state'] == 'confirmed' if objective['id'] == 'persistence' else observed.get('validation') == 'Unknown owner'
                    facts = {'requesting-principal': {'principal': observed.get('principal')},
                             'tested-behaviour': observed, 'persisted-state': actual}
                    satisfied = {'requesting-principal': observed.get('principal') == binding['actor'],
                                 'tested-behaviour': behaviour, 'persisted-state': persisted}
                    for obligation in objective['obligations']:
                        key = obligation['id']
                        evidence = {'version': 'treadway.objective-evidence/1', 'run_id': run_id,
                                    'binding': source['id'], 'obligation': key, 'boundary': obligation['boundary'],
                                    'state': 'satisfied' if satisfied[key] else 'unknown',
                                    'complete': bool(satisfied[key]), 'current': True, 'facts': facts[key]}
                        ref = private_json(directory/(source['id']+'-'+key+'.json'), evidence)
                        record['observations'].append({'binding': source['id'], 'obligation': key, 'evidence': ref})
                    record['binding_durations_ms'].append((time.monotonic()-tick)*1000)
                    if receipt['unresolved_effect'] or not all(satisfied.values()):
                        raise RuntimeError('objective_evidence_incomplete')
                record['fixture_counts'] = {key: context.fixture.state[key]-initial[key] for key in ('writes', 'refreshes')}
                record['fixture_counts']['lost'] = context.fixture.state['lost'] and not initial['lost']
                record['outcome'] = 'completed'
            finally:
                if owned:
                    context.close()
    except Exception as error:
        failure = type(error).__name__
        record['outcome'] = 'incomplete'
    record['timing'] = {'duration_ms': (time.monotonic()-started)*1000,
                        'includes': TIMING if owned else ['execution', 'checks', 'diagnostics'],
                        'calibration_ms': challenge['duration_ms']}
    record['failure_kind'] = failure
    private_json(diagnostics.directory/'links.json', {'version': 'treadway.profile-links/1',
                 'run_id': diagnostics.id, 'operations': links})
    for name, gate in challenge['gates'].items():
        record['challenges'].append({'id': name, 'evidence': private_json(directory/(name+'-challenge.json'), gate)})
    private_json(directory/'objective-run.json', record)
    return directory, record


def implementation_digest(browser_config=None):
    package = Path(treadway.__file__).parent
    runtime = {str(path.relative_to(package)): hashlib.sha256(path.read_bytes()).hexdigest()
               for path in [*package.glob('*.py'), *(package/'browser').glob('*.js'), *(package/'browser').glob('package*.json')]}
    browser = None
    if browser_config:
        browser = {'configuration': hashlib.sha256(Path(browser_config).read_bytes()).hexdigest(),
                   'engineIdentity': 'not_measured'}
    elif os.environ.get('CHROME_BIN'):
        executable = Path(os.environ['CHROME_BIN']).resolve()
        stat = executable.stat()
        browser = browser_identity(str(executable), stat.st_size, stat.st_mtime_ns)
    return fingerprint({'consumer': {name: hashlib.sha256((HERE/name).read_bytes()).hexdigest()
                        for name in ('optimise_flow.py', 'optimisation_fixture.py', 'optimisation_browser.cjs')},
                        'runtime': runtime, 'python': platform.python_version(), 'browser': browser})


@lru_cache(maxsize=4)
def browser_identity(executable, size, modified):
    with Path(executable).open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=5, check=True)
    return {'sha256': digest, 'version': result.stdout.strip()}


def challenge_contracts(root, objective, subject='http', *, browser_options=None):
    """Explicit synthetic fault executions. They never contact an external target."""
    tick = time.monotonic()
    gates = {}
    if subject != 'http':
        context = Context(Path(root)/'browser-guards', 2, lose_response='item-1', **(browser_options or {})).start()
        try:
            for name in objective['required_challenges']:
                receipt = {'state': 'not_dispatched'}
                if name == 'missing-evidence':
                    passed = compare_objective_runs(objective, [], [])['verdict'] == 'incomplete'
                elif name == 'lost-response':
                    binding = {'actor': 'member-a', 'item': 'item-1', 'values': {'owner': 'owner-b', 'revision': 1}}
                    receipt, observed = browser_binding(context, binding, name, None, context.root,
                        direct=subject == 'browser-direct', objective='persistence')
                    passed = (receipt['state'] == 'confirmed' and context.fixture.state['lost']
                              and len(context.fixture.state['attempts']) == 1 and context.fixture.state['writes'] == 1)
                else:
                    context.fixture.state['contract'] = 2 if name == 'contract-drift' else 1
                    expected = ('application_context_changed' if name == 'contract-drift' else
                                'actual_principal_differs' if name == 'wrong-actor' else 'original_resource_binding_differs')
                    changed_sessions = []
                    if name == 'wrong-actor':
                        # Keep the member-a binding/profile but change the actual
                        # fixture principal. Ownership refusal alone is insufficient.
                        context.browser_call('member-a', None, context.root, operation='session')
                        with sqlite3.connect(context.fixture.database) as db:
                            changed_sessions = db.execute('SELECT token FROM sessions WHERE actor=?', ('member-a',)).fetchall()
                            db.execute('UPDATE sessions SET actor=? WHERE actor=?', ('member-b', 'member-a'))
                    try:
                        context.browser_call('member-a', None, context.root,
                            item='item-2' if name == 'swapped-resource' else 'item-1',
                            revision=0 if name == 'stale-revision' else 1, owner='owner-b',
                            objective=objective['id'], direct=subject == 'browser-direct')
                        passed = False
                    except BrowserIncomplete as error:
                        passed = error.code == expected and context.fixture.state['writes'] == 0 and not context.fixture.state['attempts']
                    finally:
                        if changed_sessions:
                            with sqlite3.connect(context.fixture.database) as db:
                                db.executemany('UPDATE sessions SET actor=? WHERE token=?', [('member-a', row[0]) for row in changed_sessions])
                    context.fixture.state['contract'] = 1
                gates[name] = {'version': 'treadway.challenge/1', 'id': name, 'subject': subject,
                    'objective_digest': fingerprint(objective), 'implementation_digest': implementation_digest(),
                    'environment': ENVIRONMENT, 'state': 'satisfied' if passed else 'contradicted', 'complete': True,
                    'facts': {'receipt': receipt, 'writes': context.fixture.state['writes'], 'attempts': len(context.fixture.state['attempts'])}}
                if not passed:
                    raise AssertionError('synthetic_browser_challenge_failed:'+name)
        finally:
            context.close()
        return {'duration_ms': (time.monotonic()-tick)*1000, 'gates': gates}

    def execute(fixture, executor, key, *, item='item-1', revision=1):
        try:
            return executor.execute(key, '/items/'+item, method='PATCH',
                body={'id': item, 'owner': 'owner-b', 'revision': revision}, binding={'id': item},
                headers={'If-Match': str(revision)})
        except OperationIncomplete as error:
            return error.receipt

    for name in objective['required_challenges']:
        fixture = OwnerFixture(Path(root)/name, 2, lose_response='item-1' if name == 'lost-response' else None).start()
        try:
            executor = fixture.executor('member-a', Path(root)/name/'actor', maintain=name != 'intentional-authentication',
                verify=name != 'intentional-authentication', login=name != 'intentional-authentication',
                reconcile=name != 'lost-response')
            if name == 'wrong-actor':
                executor.expected = {'principal': 'member-b'}
                receipt = execute(fixture, executor, name)
                passed = receipt['state'] == 'not_dispatched' and not fixture.state['attempts']
            elif name == 'swapped-resource':
                receipt = execute(fixture, executor, name, item='item-2')
                passed = receipt['state'] == 'not_dispatched' and not fixture.state['attempts']
            elif name == 'stale-revision':
                receipt = execute(fixture, executor, name, revision=0)
                passed = receipt['state'] == 'not_dispatched' and not fixture.state['attempts']
            elif name == 'contract-drift':
                fixture.state['contract'] = 2
                with RunDiagnostics() as run:
                    receipt = execute(fixture, executor, name)
                    passed = receipt['state'] == 'not_dispatched' and not fixture.state['attempts'] and run.summary()['counts']['contract_mismatches'] == 1
            elif name == 'intentional-authentication':
                receipt = execute(fixture, executor, name)
                evidence = executor.read_evidence(name)
                observation = next(event['value'] for event in evidence['history'] if event['kind'] == 'observation')
                passed = (receipt['state'] == 'rejected' and observation['http']['status'] == 401
                          and len(fixture.state['attempts']) == 1 and fixture.state['refreshes'] == 0)
            elif name == 'lost-response':
                receipt = execute(fixture, executor, name)
                passed = receipt['state'] == 'unknown' and receipt['unresolved_effect'] and fixture.state['writes'] == 1
                # Reuse the original journal, ID and calibrated observer; no resubmit.
                executor.reconcile = fixture.executor('member-a', Path(root)/name/'observer').reconcile
                receipt = executor.reconcile_only(name)
                passed = passed and receipt['state'] == 'confirmed' and len(fixture.state['attempts']) == 1
            else:
                passed = compare_objective_runs(objective, [], [])['verdict'] == 'incomplete'
                receipt = {'state': 'not_dispatched'}
            if name != 'lost-response':
                passed = passed and fixture.state['writes'] == 0
            gates[name] = {'version': 'treadway.challenge/1', 'id': name, 'subject': subject, 'objective_digest': fingerprint(objective),
                           'implementation_digest': implementation_digest(), 'environment': ENVIRONMENT,
                           'state': 'satisfied' if passed else 'contradicted', 'complete': True,
                           'facts': {'receipt': receipt, 'writes': fixture.state['writes'], 'attempts': len(fixture.state['attempts'])}}
            if not passed:
                raise AssertionError('synthetic_challenge_failed:'+name)
        finally:
            fixture.close()
    return {'duration_ms': (time.monotonic()-tick)*1000, 'gates': gates}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--objective', choices=['persistence', 'validation'], default='persistence')
    parser.add_argument('--bindings', type=int, default=2, choices=range(1, 101), metavar='1..100')
    parser.add_argument('--benchmark', action='store_true', help='Explicitly execute separate baseline/candidate cold/warm runs')
    parser.add_argument('--repetitions', type=int, default=2, choices=range(1, 6), metavar='1..5')
    parser.add_argument('--describe', action='store_true', help='Print the objective and proposed omissions without execution')
    parser.add_argument('--output', type=Path, default=HERE/'artifacts/optimisation')
    parser.add_argument('--browser-config', type=Path, help='Explicit browser provider configuration')
    parser.add_argument('--browser-app-url', help='Browser-reachable fixture origin; {port} substitutes the local fixture port')
    parser.add_argument('--fixture-host', default='127.0.0.1', help='Explicit fixture listen address')
    args = parser.parse_args(argv)
    objective = testing_objective(args.objective, args.bindings, ('cold', 'warm') if args.benchmark else ('cold',))
    if args.describe:
        print(json.dumps({'objective': objective, 'disposition': disposition(args.objective)}))
        return 0
    if (args.benchmark or args.objective == 'validation') and not args.browser_config and not os.environ.get('CHROME_BIN'):
        parser.error('CHROME_BIN is required for the browser boundary')
    root = args.output/uuid.uuid4().hex
    root.mkdir(parents=True, mode=0o700)
    private_json(root/'objective.json', objective)
    private_json(root/'disposition.json', disposition(args.objective))
    baseline, candidate, records = [], [], []
    variants = ['baseline', 'candidate'] if args.benchmark else ['candidate']
    browser_options = {'browser_config': args.browser_config, 'browser_app_url': args.browser_app_url, 'fixture_host': args.fixture_host}
    challenges = {variant: challenge_contracts(root/'challenges'/variant, objective,
        'http' if variant == 'candidate' and args.objective == 'persistence' else 'browser-direct' if variant == 'candidate' else 'browser-list',
        browser_options=browser_options)
        for variant in variants}
    for mode in objective['modes']:
        for variant in variants:
            context = None
            shared_records = []
            prep_tick = time.monotonic()
            preparation_ms = 0
            try:
                if mode == 'warm':
                    context = Context(root/(mode+'-'+variant), args.bindings*args.repetitions*2, **browser_options).start()
                    context.prewarm(objective, 'http' if variant == 'candidate' and args.objective == 'persistence' else 'browser')
                    preparation_ms = (time.monotonic()-prep_tick)*1000
                for repeat in range(args.repetitions if args.benchmark else 1):
                    directory, record = run_sample(root, objective, variant, mode, f'sample-{repeat+1}', challenges[variant],
                        context=context, offset=repeat*args.bindings*2 if context else 0,
                        expire_after=37 if args.bindings == 100 and not args.benchmark else None,
                        lose_response='item-63' if args.bindings == 100 and not args.benchmark else None,
                        browser_options=browser_options)
                    (baseline if variant == 'baseline' else candidate).append(directory)
                    records.append(record)
                    shared_records.append((directory, record))
            finally:
                if context:
                    teardown_tick = time.monotonic()
                    try:
                        context.close()
                    except Exception:
                        for _, record in shared_records:
                            record['outcome'] = 'incomplete'
                            record['failure_kind'] = 'SharedTeardownIncomplete'
                        raise
                    finally:
                        shared = {'group': mode+'-'+variant, 'preparation_ms': preparation_ms,
                                  'teardown_ms': (time.monotonic()-teardown_tick)*1000, 'samples': len(shared_records)}
                        for directory, record in shared_records:
                            record['timing']['shared_costs'] = shared
                            private_json(directory/'objective-run.json', record)
    if args.benchmark:
        result = compare_objective_runs(objective, baseline, candidate)
    else:
        result = {'outcome': records[0]['outcome'], 'fixture_counts': records[0].get('fixture_counts'),
                  'bindings': args.bindings, 'transport': 'http' if args.objective == 'persistence' else 'browser'}
    result['artifacts'] = str(root)
    private_json(root/'comparison.json', result)
    profiles = [directory for directory in root.glob('*/diagnostics/*') if directory.is_dir()]
    private_json(root/'profile.json', summarise_profile(profiles))
    # Explicit provenance points at this run's observations, never at captured secrets.
    calibrated_digest = records[0]['implementation_digest']
    current_digest = implementation_digest(args.browser_config)
    observed_knowledge = (all(record['outcome'] == 'completed' and record['implementation_digest'] == calibrated_digest for record in records)
                          and current_digest == calibrated_digest)
    private_json(root/'knowledge.json', {'version': 'treadway.knowledge/1', 'application': ENVIRONMENT,
        'scope': 'owned-fixture', 'calibrated_at': datetime.now(timezone.utc).isoformat(),
        'implementation_digest': calibrated_digest, 'claims': [
            {'operation': 'owner-write' if args.objective == 'persistence' else 'browser-owner-validation',
             'state': 'observed' if observed_knowledge else 'unverified',
             'mapping': 'optimisation_fixture.OwnerFixture.executor' if args.objective == 'persistence' else 'optimisation_browser.execute',
             'objectives': [args.objective],
             'dependencies': ['session-and-principal', 'original-resource-revision', 'owner-api-version-1'],
             'evidence': [{'path': str(path.relative_to(root)/'objective-run.json'),
                           'sha256': hashlib.sha256((path/'objective-run.json').read_bytes()).hexdigest()}
                          for path in baseline+candidate],
             'invalidate_on': ['material-source-change', 'observed-contract-mismatch', 'authentication-contract-change']} ]})
    print(json.dumps(result), flush=True)
    return 0 if result.get('verdict') == 'qualified' or result.get('outcome') == 'completed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
