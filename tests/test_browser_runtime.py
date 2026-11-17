"""Exercise the Python owner, Node worker and independently invoked operations."""
import json
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor

import pytest
import treadway

from treadway.browser_runtime import BrowserRuntime, BrowserRuntimeIncomplete


ROOT = Path(__file__).resolve().parents[1]
CONFIG = {"browser": {"provider": "browserless", "endpoint_env": "TREADWAY_FIXTURE_ENDPOINT", "mode": "fresh"}}


@pytest.fixture
def endpoint(monkeypatch, request):
    option = getattr(request, 'param', 'Infinity')
    child = subprocess.Popen(["node", str(ROOT / "tests/remote-protocol-server.js"), 'Infinity' if option == 'shared' else str(option),
                              'shared' if option == 'shared' else 'separate'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    value = json.loads(child.stdout.readline())["endpoint"]
    monkeypatch.setenv("TREADWAY_FIXTURE_ENDPOINT", value)
    try:
        yield value
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()


def operation(connection, expression, *, timeout_ms=5000):
    script = """
    let input=''; process.stdin.on('data', c=>input+=c);
    process.stdin.on('end', async()=>{
      const value=JSON.parse(input); const {connectSession}=require(value.library); let s;
      try { s=await connectSession(value.connection,{commandTimeoutMs:value.timeoutMs}); console.log(JSON.stringify(await s.eval(value.expression))); }
      finally { s?.close(); }
    });
    """
    result = subprocess.run(["node", "-e", script], input=json.dumps({"connection": connection, "expression": expression, "timeoutMs": timeout_ms,
        "library": str(Path(treadway.__file__).with_name('browser') / 'connection.js')}),
        text=True, capture_output=True, cwd=ROOT, timeout=10)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_construction_and_invalid_configuration_are_offline(tmp_path, monkeypatch):
    monkeypatch.delenv("TREADWAY_FIXTURE_ENDPOINT", raising=False)
    runtime = BrowserRuntime(tmp_path / "evidence", configuration=CONFIG, project_root=tmp_path)
    assert runtime.process is None
    assert not list(tmp_path.iterdir())
    with pytest.raises(BrowserRuntimeIncomplete, match="remote_credentials_unavailable"):
        runtime.acquire("creator")
    assert not list(tmp_path.iterdir())
    with pytest.raises(ValueError, match="capability_unsupported"):
        BrowserRuntime(tmp_path, configuration={"provider": "browserless", "endpoint_env": "ANY", "mode": "persistent"})


def test_python_facade_keeps_one_live_target_across_operation_processes(tmp_path, endpoint):
    with BrowserRuntime(tmp_path / "artifacts", configuration=CONFIG, project_root=tmp_path) as runtime:
        actor = runtime.acquire("creator")
        with pytest.raises(BrowserRuntimeIncomplete, match='browser_actor_already_acquired'):
            runtime.acquire('creator')
        assert "synthetic" not in repr(actor)
        with runtime.drive(actor):
            assert operation(actor.connection(), "save:one") is True
            assert operation(actor.connection(), "read") == "one"
        identity = json.loads((tmp_path / ".treadway/project.json").read_text())
        assert identity["projectId"] == runtime.project_id
        journal = runtime.evidence / "events.jsonl"
        assert "synthetic" not in journal.read_text()
        assert journal.stat().st_mode & 0o077 == 0
        assert runtime.release(actor)["contextDisposed"] is True
    assert runtime.last_cleanup["complete"] is True
    assert "cleanup_result" in journal.read_text()


def test_parallel_runs_share_only_project_identity_not_browser_state(tmp_path, endpoint):
    def run(index):
        with BrowserRuntime(tmp_path / ("run-" + str(index)), configuration=CONFIG, project_root=tmp_path) as runtime:
            actor = runtime.acquire("creator")
            assert operation(actor.connection(), "read") == ""
            assert operation(actor.connection(), "save:" + str(index)) is True
            assert operation(actor.connection(), "read") == str(index)
            return runtime.project_id, runtime.run_id, actor.generation
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(run, [1, 2]))
    assert first[0] == second[0]
    assert first[1] != second[1]
    assert first[2] != second[2]


def test_foreign_runtime_cannot_release_another_runs_actor(tmp_path, endpoint):
    with BrowserRuntime(tmp_path / "one", configuration=CONFIG, project_root=tmp_path) as a:
        with BrowserRuntime(tmp_path / "two", configuration=CONFIG, project_root=tmp_path) as b:
            actor = a.acquire("creator")
            with pytest.raises(BrowserRuntimeIncomplete, match="binding_differs"):
                b.release(actor)
            assert operation(actor.connection(), "read") == ""


def test_shared_provider_configuration_does_not_merge_project_identities(tmp_path, endpoint):
    config = tmp_path / 'shared-browser.json'
    config.write_text(json.dumps(CONFIG))
    with BrowserRuntime.from_file(config, root=tmp_path/'one/artifacts', project_root=tmp_path/'one') as one:
        with BrowserRuntime.from_file(config, root=tmp_path/'two/artifacts', project_root=tmp_path/'two') as two:
            first, second = one.acquire('member'), two.acquire('member')
            assert one.project_id != two.project_id
            assert operation(first.connection(), 'save:first-project') is True
            assert operation(second.connection(), 'read') == ''
    assert not (tmp_path / '.treadway').exists()


def test_closing_owner_pipe_stops_worker_and_retains_cleanup_evidence(tmp_path, endpoint):
    runtime = BrowserRuntime(tmp_path / "artifacts", configuration=CONFIG, project_root=tmp_path)
    try:
        runtime.acquire("creator")
        runtime.process.stdin.close()
        runtime.process.wait(timeout=5)
        events = [json.loads(line) for line in (runtime.evidence / "events.jsonl").read_text().splitlines()]
        cleanup = next(event for event in events if event["kind"] == "cleanup_result")
        assert cleanup["contextDisposed"] is True
        assert events[-1]["kind"] == "worker_stopped"
    finally:
        runtime.close()


@pytest.mark.parametrize("endpoint", [1], indirect=True)
def test_multi_actor_capacity_failure_releases_only_its_partial_allocations(tmp_path, endpoint):
    with BrowserRuntime(tmp_path / "artifacts", configuration=CONFIG, project_root=tmp_path) as runtime:
        with pytest.raises(BrowserRuntimeIncomplete) as caught:
            runtime.acquire_many(["creator", "approver"])
        assert caught.value.details.get("status") == 429, vars(caught.value)
        assert runtime.last_partial_cleanup[0]["contextDisposed"] is True
    # The released slot is available for another independent project.
    with BrowserRuntime(tmp_path / "other", configuration=CONFIG, project_root=tmp_path / "other-project") as other:
        actor = other.acquire("creator")
        assert operation(actor.connection(), "read") == ""


def test_entra_recipe_uses_remote_owned_connection_inside_drive(tmp_path, endpoint, monkeypatch):
    from robot.libraries.BuiltIn import BuiltIn
    from treadway.entra_robot import EntraLibrary

    refs = tmp_path / 'identities.json'
    refs.write_text(json.dumps({'providers': {'env': {'type': 'environment'}}, 'identities': {
        'member': {'expected': {'principal': 'synthetic-member'}, 'credentials': {
            'username': {'provider': 'env', 'name': 'UNUSED_USERNAME'},
            'password': {'provider': 'env', 'name': 'UNUSED_PASSWORD'}}}}}))
    config = tmp_path / 'entra.json'
    config.write_text(json.dumps({'credentials': str(refs), 'project_root': str(tmp_path),
        'application': {'origin': 'https://workboard.example.invalid', 'principal_probe': '/principal'},
        'browser': {**CONFIG['browser'], 'root': str(tmp_path / 'browsers')}}))
    monkeypatch.setattr(BuiltIn, 'get_variable_value', lambda *args: str(tmp_path / 'output'))
    captured = []

    def login(command, **options):
        payload = json.loads(options['input_data'])
        connection = payload['connection']
        assert connection['kind'] == 'run-worker' and connection['driveLease']
        assert operation(connection, 'read') == ''
        assert endpoint not in options['input_data']
        captured.append(payload)
        return {'payload': {'status': 'verified'}, 'failure': None, 'exitCode': 0}

    monkeypatch.setattr('treadway.entra_robot.run_json_process', login)
    result = EntraLibrary(config).sign_in_with_entra('member')
    assert result['browser']['provider'] == 'browserless'
    assert result['browser']['persistent'] is False
    assert result['cleanup']['complete'] is True
    assert len(captured) == 1


def test_invalid_deadlines_and_actor_lists_fail_before_state_creation(tmp_path):
    runtime = BrowserRuntime(tmp_path / 'evidence', configuration=CONFIG, project_root=tmp_path)
    for value in [True, float('nan'), float('inf'), 'soon']:
        with pytest.raises(ValueError, match='finite_monotonic_deadline_required'):
            runtime.acquire('member', deadline=value)
    for names in [[], ['member', 'member'], [['invalid']]]:
        with pytest.raises(ValueError, match='distinct_actor_names_required'):
            runtime.acquire_many(names)
    assert not list(tmp_path.iterdir())


def test_project_identity_lock_respects_acquisition_deadline(tmp_path, endpoint):
    import fcntl
    import time

    directory = tmp_path / '.treadway'
    directory.mkdir(mode=0o700)
    with (directory / 'project.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with BrowserRuntime(tmp_path / 'artifacts', configuration=CONFIG, project_root=tmp_path) as runtime:
            start = time.monotonic()
            with pytest.raises(BrowserRuntimeIncomplete, match='project_identity_deadline'):
                runtime.acquire('member', deadline=start + .15)
            assert time.monotonic() - start < 1
            assert runtime.process is None


def test_independent_reconciliation_is_retained_without_unlocking_uncertain_remote_execution(tmp_path, endpoint):
    import hashlib
    import time

    with BrowserRuntime(tmp_path / 'artifacts', configuration=CONFIG, project_root=tmp_path) as runtime:
        actor = runtime.acquire('member')
        with pytest.raises(AssertionError, match='unknown|timed out|remote_command_incomplete'):
            operation(actor.connection(), 'lose-reply', timeout_ms=100)
        deadline = time.monotonic() + 2
        while True:
            commands = runtime.inspect(actor)['commands']
            unknown = [command for command in commands if command['outcome'] == 'unknown']
            if unknown or time.monotonic() >= deadline:
                break
            time.sleep(.01)
        assert len(unknown) == 1
        source = tmp_path / 'application-observation.json'
        source.write_text(json.dumps({'saved': 'committed', 'writes': 1}))
        source.chmod(0o600)
        result = runtime.record_reconciliation(actor, request_ref=unknown[0]['requestRef'], outcome='applied', evidence=source)
        assert result == {'recorded': True, 'reconciliationRequired': True, 'remoteExecution': 'unconfirmed'}
        # A later change to the original observer output cannot rewrite the receipt.
        original = source.read_bytes()
        source.write_text('{}')
        copies = list((runtime.evidence / 'reconciliations').iterdir())
        assert len(copies) == 1 and copies[0].read_bytes() == original
        inspected = next(command for command in runtime.inspect(actor)['commands'] if command['requestRef'] == unknown[0]['requestRef'])
        assert inspected['reconciliation']['evidence']['sha256'] == hashlib.sha256(original).hexdigest()
        with pytest.raises(BrowserRuntimeIncomplete, match='reconciliation_required'):
            with runtime.drive(actor):
                pytest.fail('Unconfirmed remote execution cannot grant another mutation lease')


def test_worker_death_retains_missing_reply_as_unknown_without_contacting_provider(tmp_path, endpoint, monkeypatch):
    import time
    from treadway.browser_receipts import inspect_browser_run

    runtime = BrowserRuntime(tmp_path/'artifacts', configuration=CONFIG, project_root=tmp_path)
    try:
        actor = runtime.acquire('member')
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(operation, actor.connection(), 'lose-reply')
            deadline = time.monotonic()+5
            # Initialization has one Runtime.evaluate, then the actual invocation.
            while True:
                observed = inspect_browser_run(runtime.evidence, project_id=runtime.project_id, run_id=runtime.run_id)
                commands = observed['actors'][0]['commands']
                evaluates = [command for command in commands if command['method'] == 'Runtime.evaluate']
                if len(evaluates) == 2 and evaluates[-1]['outcome'] == 'unknown':
                    break
                assert time.monotonic() < deadline, 'test operation was not dispatched'
                time.sleep(.01)
            runtime.process.kill()
            runtime.process.wait(timeout=2)
            with pytest.raises(AssertionError):
                pending.result(timeout=3)
        monkeypatch.delenv('TREADWAY_FIXTURE_ENDPOINT')
        before = (runtime.evidence/'events.jsonl').read_bytes()
        observed = inspect_browser_run(runtime.evidence, project_id=runtime.project_id, run_id=runtime.run_id)
        assert observed['journalComplete'] is True
        assert observed['workerStoppedObserved'] is False
        assert observed['resumePermitted'] is False
        retained, = observed['actors']
        assert retained['cleanup'] is None
        assert retained['unresolvedEffects'] == [evaluates[-1]['requestRef']]
        assert (runtime.evidence/'events.jsonl').read_bytes() == before
    finally:
        runtime.close()


def test_one_local_cleanup_failure_does_not_skip_other_owned_browsers(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from treadway.browser_runtime import RuntimeSession

    runtime = BrowserRuntime(tmp_path/'artifacts')
    attempted = []
    for name in ['author', 'reviewer']:
        actor = RuntimeSession(name, 'local', name+'-generation', {}, _local=SimpleNamespace(name=name))
        runtime.sessions[actor.generation] = actor

    def stop(local):
        attempted.append(local.name)
        if local.name == 'author':
            raise RuntimeError('synthetic_cleanup_failure')

    monkeypatch.setattr(runtime.local, 'stop', stop)
    assert runtime.close()['complete'] is False
    assert attempted == ['author', 'reviewer']
    assert not list(tmp_path.iterdir())


def test_saved_identity_owner_death_requires_recorded_cleanup_before_explicit_recovery(tmp_path, endpoint):
    import sys
    import time
    from treadway.browser_state import BrowserIdentity, BrowserStateIncomplete

    source = '''
import json,os,sys
from pathlib import Path
from treadway.browser_runtime import BrowserRuntime
from treadway.browser_state import BrowserIdentity
root=Path(sys.argv[1])
identity=BrowserIdentity(root/'identities','member-resource','workboard','member','service',('https://app.example.invalid',))
runtime=BrowserRuntime(root/'run',project_root=root/'project',configuration={
 'provider':'browserless','binding':'service','endpoint_env':'TREADWAY_FIXTURE_ENDPOINT'})
actor=runtime.acquire_identity('member',identity,restore=False,principal={
 'origin':identity.origins[0],'probe':'/principal','expected':{'principal':'member'}})
print(json.dumps({'projectId':runtime.project_id,'runId':runtime.run_id,'generation':actor.generation,
 'evidence':str(runtime.evidence)}),flush=True)
os._exit(0)
'''
    child = subprocess.run([sys.executable, '-c', source, str(tmp_path)], text=True, capture_output=True, timeout=10)
    assert child.returncode == 0, child.stderr
    binding = json.loads(child.stdout)
    state = BrowserIdentity(tmp_path/'identities', 'member-resource', 'workboard', 'member', 'service', ('https://app.example.invalid',))
    with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
        state.acquire(binding['projectId'])
    journal = Path(binding['evidence'])/'events.jsonl'
    deadline = time.monotonic()+5
    while 'worker_stopped' not in journal.read_text():
        assert time.monotonic() < deadline, 'owned worker did not record bounded cleanup'
        time.sleep(.01)
    assert state.recover(binding['projectId'], run_id=binding['runId'], actor='member',
                         generation=binding['generation'])['previousGenerationResumed'] is False
    lease = state.acquire(binding['projectId'])
    lease.release(context_disposed=True, uncertain=False)


def borrowed_identity(tmp_path, resource='member', **changes):
    from treadway.browser_state import BrowserIdentity
    return BrowserIdentity(**{'root': tmp_path/'shared-identities', 'resource': resource,
        'application': 'workboard', 'identity_ref': 'member', 'provider_binding': 'service',
        'origins': ('https://app.example.invalid',), **changes})


def provide_attachment(monkeypatch, operator, endpoint, *, permission='drive'):
    events = [json.loads(line) for line in (operator.evidence/'events.jsonl').read_text().splitlines()]
    binding = {'version': 1, 'endpoint': endpoint, 'contextId': next(event['contextId'] for event in events if event['kind'] == 'context_acquired'),
        'targetId': next(event['targetId'] for event in events if event['kind'] == 'acquisition_ready'),
        'scope': 'context', 'permission': permission}
    monkeypatch.setenv('TREADWAY_BORROWED_ATTACHMENT', json.dumps(binding))
    return binding


BORROWED = {'provider': 'browserless', 'binding': 'service', 'mode': 'borrowed', 'attachment_env': 'TREADWAY_BORROWED_ATTACHMENT'}


@pytest.mark.parametrize('endpoint', ['shared'], indirect=True)
def test_borrowed_context_aliases_share_one_lifetime_lease_and_preserve_operator_state(tmp_path, endpoint, monkeypatch):
    from treadway.browser_state import BrowserStateIncomplete
    with BrowserRuntime(tmp_path/'operator', configuration=CONFIG, project_root=tmp_path/'operator-project') as operator:
        original = operator.acquire('operator')
        assert operation(original.connection(), 'save:operator-value') is True
        binding = provide_attachment(monkeypatch, operator, endpoint)
        state = borrowed_identity(tmp_path)
        with BrowserRuntime(tmp_path/'one', configuration=BORROWED, project_root=tmp_path/'project') as one:
            member = one.borrow('member', state, permission='drive')
            with one.drive(member):
                assert operation(member.connection(), 'read') == 'operator-value'
                assert operation(member.connection(), 'save:borrowed-value') is True
            with BrowserRuntime(tmp_path/'alias', configuration=BORROWED, project_root=tmp_path/'project') as alias:
                with pytest.raises(BrowserStateIncomplete, match='identity_in_use'):
                    alias.borrow('different-name', borrowed_identity(tmp_path, resource='different-resource'))
                assert alias.process is None
            with BrowserRuntime(tmp_path/'other-project', configuration=BORROWED, project_root=tmp_path/'other-project') as other:
                with pytest.raises(BrowserStateIncomplete, match='identity_in_use'):
                    other.borrow('member', borrowed_identity(tmp_path, resource='another-resource'))
                assert other.process is None
            assert binding['contextId'] not in repr(member) and binding['endpoint'] not in repr(member)
            result = one.release(member)
            assert result['attachmentDetached'] and not result['contextDisposed']
            assert not result['identity']['recoveryRequired'] and not result['contextLease']['recoveryRequired']
        with BrowserRuntime(tmp_path/'later', configuration=BORROWED, project_root=tmp_path/'project') as later:
            member = later.borrow('member', state, permission='drive')
            assert operation(member.connection(), 'read') == 'borrowed-value'
        assert operation(original.connection(), 'read') == 'borrowed-value'


@pytest.mark.parametrize('endpoint', ['shared'], indirect=True)
def test_borrowed_observation_uses_python_bridge_without_page_initialization(tmp_path, endpoint, monkeypatch):
    from treadway.cdp import CdpSocket, CommandSession
    with BrowserRuntime(tmp_path/'operator', configuration=CONFIG, project_root=tmp_path/'operator-project') as operator:
        original = operator.acquire('operator')
        assert operation(original.connection(), 'save:operator-value') is True
        provide_attachment(monkeypatch, operator, endpoint, permission='observe')
        with BrowserRuntime(tmp_path/'observer', configuration=BORROWED, project_root=tmp_path/'project') as observer:
            with pytest.raises(BrowserRuntimeIncomplete, match='borrowed_binding_invalid'):
                observer.borrow('forbidden', borrowed_identity(tmp_path), permission='drive')
            assert observer.process is None
            member = observer.borrow('member', borrowed_identity(tmp_path))
            with observer.drive(member):
                socket = CdpSocket(connection=member.connection(), observation_only=True)
                try:
                    cdp = CommandSession(socket)
                    assert cdp.command('Storage.getCookies') == {'cookies': []}
                    with pytest.raises(RuntimeError, match='remote_observation_only; outcome not_dispatched'):
                        cdp.command('Runtime.evaluate', {'expression': 'save:forbidden'})
                finally:
                    socket.close()
            assert observer.release(member)['contextLease']['recoveryRequired'] is False
        assert operation(original.connection(), 'read') == 'operator-value'


def test_borrowed_construction_and_wrong_entry_points_are_passive(tmp_path, monkeypatch):
    monkeypatch.delenv('TREADWAY_BORROWED_ATTACHMENT', raising=False)
    runtime = BrowserRuntime(tmp_path/'run', configuration=BORROWED, project_root=tmp_path/'project')
    with pytest.raises(ValueError, match='explicit_borrow_required'):
        runtime.acquire('member')
    with pytest.raises(BrowserRuntimeIncomplete, match='borrowed_binding_invalid'):
        runtime.borrow('member', borrowed_identity(tmp_path))
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('endpoint', ['shared'], indirect=True)
def test_borrowed_unknown_write_keeps_all_resource_aliases_blocked_after_detach(tmp_path, endpoint, monkeypatch):
    from treadway.browser_state import BrowserStateIncomplete
    with BrowserRuntime(tmp_path/'operator', configuration=CONFIG, project_root=tmp_path/'operator-project') as operator:
        original = operator.acquire('operator')
        provide_attachment(monkeypatch, operator, endpoint)
        with BrowserRuntime(tmp_path/'borrower', configuration=BORROWED, project_root=tmp_path/'project') as borrower:
            member = borrower.borrow('member', borrowed_identity(tmp_path), permission='drive')
            with borrower.drive(member):
                with pytest.raises(AssertionError, match='unknown|timed out|remote_command_incomplete'):
                    operation(member.connection(), 'lose-reply', timeout_ms=100)
            released = borrower.release(member)
            assert released['attachmentDetached'] and not released['contextDisposed']
            assert released['identity']['recoveryRequired'] and released['contextLease']['recoveryRequired']
        with BrowserRuntime(tmp_path/'alias', configuration=BORROWED, project_root=tmp_path/'project') as alias:
            with pytest.raises(BrowserStateIncomplete, match='recovery_required'):
                alias.borrow('member', borrowed_identity(tmp_path, resource='alias'), permission='drive')
            assert alias.process is None
        assert operation(original.connection(), 'read') == 'committed'


def test_startup_failure_stops_the_partially_started_worker(tmp_path, endpoint, monkeypatch):
    runtime = BrowserRuntime(tmp_path / 'artifacts', configuration=CONFIG, project_root=tmp_path)
    original = runtime._rpc

    def fail_configuration(**request):
        if 'configuration' in request:
            raise RuntimeError('synthetic_startup_failure')
        return original(**request)

    monkeypatch.setattr(runtime, '_rpc', fail_configuration)
    with pytest.raises(RuntimeError, match='synthetic_startup_failure'):
        runtime.acquire('member')
    assert runtime.process.poll() is not None
    assert not runtime.socket_root.exists()
    assert (runtime.evidence / 'worker-stderr.log').exists()
    with pytest.raises(BrowserRuntimeIncomplete, match='browser_runtime_closed'):
        runtime.acquire('member')
