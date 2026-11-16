"""Real synthetic effects and hostile diagnostic sinks, never external targets."""
import io
import importlib.util
import json
from pathlib import Path
import threading
import time
import subprocess
import sys

import pytest

from treadway.diagnostics import (ConsoleSink, FlowChanged, RunDiagnostics, current_run, reference)
from treadway.recovery import OperationIncomplete
_spec = importlib.util.spec_from_file_location('recovery_fixtures', Path(__file__).with_name('test_recovery.py'))
_fixtures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fixtures)
application, configured, execute = _fixtures.application, _fixtures.configured, _fixtures.execute


def test_passive_constructor_and_disabled_instrumentation(tmp_path, application, capsys):
    RunDiagnostics(tmp_path/'not-created', console=True)
    assert not (tmp_path/'not-created').exists()
    executor, _, _ = configured(tmp_path, application)
    assert execute(executor)['state'] == 'confirmed'
    assert capsys.readouterr() == ('', '')


def test_100_bindings_one_refresh_and_cached_result_have_accurate_counts(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    state['lost'].add('mutation-63')
    events = []
    with RunDiagnostics(tmp_path/'diagnostics', sinks=[events.append]) as run:
        for index in range(1, 101):
            assert execute(executor, index)['state'] == 'confirmed'
        assert execute(executor, 38)['cached']
    summary = run.summary()
    assert summary['counts']['operation_calls'] == 101
    assert summary['counts']['cached_returns'] == 1
    assert summary['counts']['dispatch_reservations'] == 100
    assert summary['counts']['principal_checks'] == 101
    assert len([e for e in events if e['event'] == 'http_dispatched' and e['phase'] == 'mutation']) == 100
    assert len([e for e in events if e['event'] == 'authentication_started' and e['phase'] == 'renew']) == 1
    assert summary['operation_outcomes'] == {'confirmed': 101}
    assert len(state['effects']) == 100 and state['refreshes'] == 1
    assert summary['telemetry_complete']
    stored = [json.loads(line) for line in (run.directory/'events.jsonl').read_text().splitlines()]
    assert len(stored) == len(events)
    assert json.loads((run.directory/'summary.json').read_text())['telemetry_complete']


def test_private_values_and_hostile_stderr_never_reach_safe_sinks(tmp_path, application):
    executor, _, _ = configured(tmp_path, application)
    sentinel = 'private-canary-never-log'
    executor.session._credentials = lambda: {'Authorization': sentinel}
    output = io.StringIO()
    events = []
    with RunDiagnostics(sinks=[ConsoleSink(output, 'DEBUG'), events.append]) as run:
        for line in [sentinel, json.dumps({'treadway_event': {'message': sentinel}}),
                     json.dumps({'treadway_event': {'run_id': run.id, 'event': 'http_dispatched',
                                                  'level': 'DEBUG', 'fields': {'body': sentinel}}})]:
            run.accept_bridge(line)
        with pytest.raises(OperationIncomplete):
            executor.execute(sentinel, '/mutations?token='+sentinel, body={'private': sentinel}, binding={'id': sentinel})
    assert sentinel not in output.getvalue()+json.dumps(events)+json.dumps(run.summary())
    assert not run.summary()['telemetry_complete']


def test_raising_and_hanging_sinks_cannot_change_the_effect(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    release = threading.Event()
    def broken(event):
        raise RuntimeError('private sink failure')
    with RunDiagnostics(sinks=[broken]) as run:
        assert execute(executor)['state'] == 'confirmed'
    assert run.summary()['diagnostic_errors'] == 1
    try:
        started = time.monotonic()
        with RunDiagnostics(sinks=[lambda event: release.wait(10)], queue_size=2, flush_seconds=.01) as blocked:
            assert execute(executor, 2)['state'] == 'confirmed'
        assert time.monotonic()-started < 2
        assert blocked.summary()['dropped_events'] > 0
        assert not blocked.summary()['telemetry_complete']
    finally:
        release.set()
    assert len(state['effects']) == 2


def test_nested_runs_restore_context_and_use_different_keyed_references():
    with RunDiagnostics() as parent:
        ref = reference('predictable-sensitive-value')
        with RunDiagnostics() as child:
            assert reference('predictable-sensitive-value') != ref
            assert current_run() is child
        assert current_run() is parent
    assert current_run() is None
    assert parent.id != child.id


def test_implementation_guard_stops_dispatch_but_allows_read_only_reconciliation(tmp_path, application):
    source = tmp_path/'flow.py'
    source.write_text('BINDING_VERSION = 1\n')
    executor, state, _ = configured(tmp_path, application, reconcile=None)
    state['lost'].add('mutation-1')
    with RunDiagnostics(watch=[source]) as run:
        with pytest.raises(OperationIncomplete):
            execute(executor)
        source.write_text('BINDING_VERSION = 2\n')
        with pytest.raises(OperationIncomplete) as stopped:
            execute(executor)
        assert stopped.value.receipt['unresolved_effect']
        assert stopped.value.receipt['state'] == 'unknown'
        # Reuse a calibrated observer; no authentication callback or mutation.
        calibrated, _, _ = configured(tmp_path, application)
        executor.reconcile = calibrated.reconcile
        assert executor.reconcile_only('mutation-1')['state'] == 'confirmed'
    assert state['calls'].count(('POST', '/mutations')) == 1
    assert run.summary()['implementation_changed']


def test_definition_guard_ignores_python_formatting_but_detects_replacement_and_deletion(tmp_path):
    source = tmp_path/'flow.py'
    source.write_text('value = 1\n')
    with RunDiagnostics(watch=[source]) as run:
        source.write_text('# formatting only\nvalue=1\n')
        run.checkpoint()
        source.unlink()
        with pytest.raises(FlowChanged) as error:
            run.checkpoint()
        assert error.value.report['reason'] == 'source_unavailable'
    assert run.summary()['events']['implementation_changed'] == 1
    with pytest.raises(ValueError, match='readable_flow_definition'):
        with RunDiagnostics(watch=[source]):
            pass


def test_material_contract_mismatch_is_explicit_and_not_a_timeout_diagnosis(tmp_path, application):
    executor, state, _ = configured(tmp_path, application)
    with RunDiagnostics() as run:
        executor.prerequisite = lambda op: run.check_contract('resource-revision', expected=1, observed=2)
        with pytest.raises(OperationIncomplete) as error:
            execute(executor)
        assert error.value.receipt['code'] == 'flow_changed_before_dispatch'
        assert not state['effects']
        assert run.check_contract('optional-presentation', expected=1, observed=2, material=False) is False
    assert run.summary()['counts']['contract_mismatches'] == 2


def test_robot_listener_reports_live_machinery_and_summary_and_is_passive_in_dryrun(tmp_path):
    from treadway.authoring import main
    project = tmp_path/'flow with spaces'
    main(['new', str(project)])
    output = tmp_path/'diagnostics'
    listener = f'treadway.diagnostics_robot.DiagnosticsListener:{output}:DEBUG:true'
    result = subprocess.run([sys.executable, '-m', 'robot', '--listener', listener, '--loglevel', 'DEBUG',
                             '--outputdir', str(tmp_path/'robot'), 'session_recovery.robot'],
                            cwd=project, capture_output=True, text=True, timeout=35)
    assert result.returncode == 0, result.stdout+result.stderr
    assert 'authentication_started' in result.stderr
    summary_path, = output.glob('*/summary.json')
    summary = json.loads(summary_path.read_text())
    assert summary['telemetry_complete']
    assert summary['counts']['operation_calls'] == 101
    assert summary['counts']['authentication_renewals'] == 1
    assert summary['events']['keyword_started'] > 100
    # Live events also belong to Robot's ordinary HTML/result model.
    assert 'treadway.event/1' in (tmp_path/'robot/output.xml').read_text()
    assert 'http_dispatched' in (tmp_path/'robot/output.xml').read_text()
    passive = tmp_path/'dryrun-diagnostics'
    result = subprocess.run([sys.executable, '-m', 'robot', '--dryrun', '--listener',
        f'treadway.diagnostics_robot.DiagnosticsListener:{passive}:DEBUG',
        '--outputdir', str(tmp_path/'dryrun'), 'session_recovery.robot'],
        cwd=project, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout+result.stderr
    assert not passive.exists()


def test_killed_subprocess_retains_live_events_and_incomplete_statistics(tmp_path):
    from treadway.process import run_json_process
    with RunDiagnostics() as run:
        seen = []
        configuration = run.bridge()
        code = ('import json,sys,time\n'
                'config=json.load(sys.stdin)\n'
                'for sequence,event in enumerate(["bridge_started","browser_action_started"],1):\n'
                ' print(json.dumps({"treadway_event":dict(config,sequence=sequence,event=event,level="INFO",fields={})}),file=sys.stderr,flush=True)\n'
                'time.sleep(30)\n')
        result = run_json_process([sys.executable, '-c', code],
                                  input_data=json.dumps(configuration), timeout_seconds=2, on_stderr=seen.append)
    assert result['failure'] == 'process_deadline'
    summary = run.summary()
    assert summary['events']['browser_action_started'] == 1
    assert not summary['telemetry_complete']
    assert len(result['stderrLines']) == 2
    assert seen == result['stderrLines']


def test_real_node_bridge_has_ordered_safe_events_and_separate_result_stdout():
    from treadway import diagnostics
    from treadway.process import run_json_process
    module = Path(diagnostics.__file__).parent/'browser/diagnostics.js'
    sentinel = 'private-selector-token-exception-canary'
    code = ('const fs=require("fs");const d=require(process.argv[1]);'
            'const c=JSON.parse(fs.readFileSync(0,"utf8"));'
            'd.withDiagnostics(c,async()=>{'
            'd.emit("browser_screen",{stage:"password",body:process.argv[2]});'
            'd.emit("browser_screen",{stage:process.argv[2]});'
            'process.stdout.write(JSON.stringify({complete:true}));});')
    events = []
    with RunDiagnostics(sinks=[events.append]) as run:
        result = run_json_process(['node', '-e', code, str(module), sentinel], input_data=json.dumps(run.bridge()))
    assert result['payload'] == {'complete': True} and result['failure'] is None
    assert sentinel not in json.dumps(events)
    assert [event['event'] for event in events].count('browser_screen') == 2
    assert any(event.get('stage') == 'password' for event in events)
    assert run.summary()['telemetry_complete']


def test_unknown_or_out_of_order_producer_is_reported_incomplete():
    with RunDiagnostics() as run:
        config = run.bridge()
        event = {'treadway_event': {**config, 'sequence': 2, 'event': 'browser_action_started',
                                    'level': 'DEBUG', 'fields': {}}}
        run.accept_bridge(json.dumps(event))
    assert run.summary()['events']['bridge_invalid'] == 1
    assert 'browser_action_started' not in run.summary()['events']
    assert not run.summary()['telemetry_complete']


def test_malformed_fields_are_diagnostic_only_and_never_hide_a_result():
    from treadway.process import run_json_process
    code = ('import json,sys\nc=json.load(sys.stdin)\n'
            'print(json.dumps({"treadway_event":dict(c,event="bridge_started",sequence=1,level="DEBUG",fields=[])}),file=sys.stderr)\n'
            'print(json.dumps({"effect":"confirmed"}))\n')
    with RunDiagnostics() as run:
        result = run_json_process([sys.executable, '-c', code], input_data=json.dumps(run.bridge()))
    assert result['payload'] == {'effect': 'confirmed'} and result['failure'] is None
    assert run.summary()['events']['bridge_invalid'] == 1


def test_trace_emission_never_replaces_original_incomplete_receipt(tmp_path, application):
    executor, _, _ = configured(tmp_path, application)
    from treadway import diagnostics as diag
    def stopped(*args, **kwargs):
        raise OperationIncomplete({'state': 'retry_permitted', 'unresolved_effect': True})
    executor.assess = lambda *args: stopped()
    with RunDiagnostics() as run:
        with pytest.raises(OperationIncomplete) as original:
            execute(executor)
        assert original.value.receipt['state'] == 'unknown'
        with pytest.raises(OperationIncomplete) as error:
            with diag.span('operation') as trace:
                trace['outcome'] = 'an-invalid-telemetry-value'
                stopped()
        assert error.value.receipt['state'] == 'retry_permitted'
    assert run.summary()['diagnostic_errors'] == 1


def test_nested_run_does_not_inherit_outer_span_identifiers():
    from treadway.diagnostics import span
    events = []
    with RunDiagnostics() as outer:
        with span('operation', operation_ref=reference('outer-operation')):
            with RunDiagnostics(sinks=[events.append]) as inner:
                assert current_run() is inner
        assert current_run() is outer
    assert all('operation_ref' not in event and 'span_id' not in event for event in events)


def test_parent_flow_baseline_blocks_browser_launch_and_child_lifetime_changes(tmp_path, monkeypatch):
    from treadway.robot import FormLibrary
    from treadway import robot as robot_module, diagnostics
    from treadway.process import run_json_process
    from unittest.mock import Mock
    source = tmp_path/'flow.py'
    source.write_text('version=1\n')
    runner = Mock(side_effect=AssertionError('browser must not launch'))
    monkeypatch.setattr(robot_module, 'run_json_process', runner)
    with RunDiagnostics(watch=[source]):
        source.write_text('version=2\n')
        with pytest.raises(FlowChanged):
            FormLibrary('127.0.0.1', 1, 'target', str(tmp_path/'journal'))._run('attempt')
    runner.assert_not_called()
    module = Path(diagnostics.__file__).parent/'browser/diagnostics.js'
    with RunDiagnostics(tmp_path/'output', watch=[source]) as run:
        configuration = run.bridge()
        source.write_text('version=3\n')
        code = ('const fs=require("fs"),d=require(process.argv[1]),c=JSON.parse(fs.readFileSync(0,"utf8"));'
                'd.withDiagnostics(c,async()=>{try{d.checkpoint();process.stdout.write("{}");}'
                'catch(e){process.stdout.write(JSON.stringify({blocked:e.code}));}});')
        result = run_json_process(['node', '-e', code, str(module)], input_data=json.dumps(configuration))
        assert result['payload'] == {'blocked': 'FLOW_CHANGED'}
    changes = list(run.directory.glob('change-*.json'))
    assert len(changes) == 1
    record = json.loads(changes[0].read_text())
    assert record['path'] == str(source)
    assert record['expected_fingerprint'] != record['observed_fingerprint']
    assert run.summary()['implementation_changed']


def test_shipped_debug_script_reports_statistics_and_observed_contract_change(tmp_path):
    from treadway.authoring import main
    project = tmp_path/'debug example'
    main(['new', str(project)])
    for extra, expected_exit, confirmed in [([], 0, 100), (['--simulate-contract-change-at', '38'], 1, 37)]:
        result = subprocess.run([sys.executable, 'debug_recovery.py', '--no-console', *extra],
                                cwd=project, text=True, capture_output=True, timeout=35)
        assert result.returncode == expected_exit, result.stdout+result.stderr
        assert not result.stderr
        payload = json.loads(result.stdout)
        assert payload['statistics']['operation_outcomes']['confirmed'] == confirmed
        assert payload['statistics']['telemetry_complete']
        if expected_exit:
            assert payload['code'] == 'flow_contract_changed'
            assert payload['statistics']['counts']['contract_mismatches'] == 1
            assert payload['statistics']['outcome'] == 'failed'


def test_node_stderr_epipe_does_not_terminate_the_work():
    from treadway import diagnostics
    module = Path(diagnostics.__file__).parent/'browser/diagnostics.js'
    code = ('const fs=require("fs"),d=require(process.argv[1]),c=JSON.parse(fs.readFileSync(0,"utf8"));'
            'd.withDiagnostics(c,async()=>{for(let i=0;i<100;i++)d.emit("browser_screen",{stage:"password"});'
            'await new Promise(r=>setTimeout(r,100));process.stdout.write(JSON.stringify({effect:"confirmed"}));});')
    with RunDiagnostics() as run:
        process = subprocess.Popen(['node', '-e', code, str(module)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.stderr.close()
        process.stderr = None
        stdout, _ = process.communicate(json.dumps(run.bridge()), timeout=5)
        assert process.returncode == 0
        assert json.loads(stdout) == {'effect': 'confirmed'}
    assert not run.summary()['telemetry_complete']


def test_final_stderr_drain_invokes_callback_exactly_once(monkeypatch):
    from treadway import process as process_module
    import queue
    original = queue.Queue
    class BufferedQueue(original):
        def get(self, block=True, timeout=None):
            if block:
                time.sleep(.01)
                raise queue.Empty()
            return super().get(block=False)
    monkeypatch.setattr(process_module.queue, 'Queue', BufferedQueue)
    seen = []
    result = process_module.run_json_process([sys.executable, '-c',
        'import sys;print("first",file=sys.stderr);print("last",file=sys.stderr);print("{}")'],
        timeout_seconds=1, on_stderr=seen.append)
    assert seen == result['stderrLines'] == ['first', 'last']


def test_producer_capacity_cannot_disable_an_enabled_guard(tmp_path):
    source = tmp_path/'flow.py'
    source.write_text('version=1\n')
    with RunDiagnostics(watch=[source], max_sources=2) as run:
        assert run.bridge()['guard_enabled']
        assert run.bridge()['guard_enabled']
        with pytest.raises(RuntimeError, match='guarded_diagnostic_source_capacity'):
            run.bridge()
    assert not run.summary()['telemetry_complete']


def test_unknown_pointer_receipt_stays_unknown_in_browser_telemetry():
    from treadway import diagnostics
    from treadway.process import run_json_process
    module = Path(diagnostics.__file__).parent/'browser/diagnostics.js'
    code = ('const fs=require("fs"),d=require(process.argv[1]),c=JSON.parse(fs.readFileSync(0,"utf8"));'
            'd.withDiagnostics(c,async()=>{d.machinery("action_finished",{actionDispatch:"attempted",recordStatus:"recorded"});'
            'process.stdout.write("{}");});')
    events = []
    with RunDiagnostics(sinks=[events.append]) as run:
        run_json_process(['node', '-e', code, str(module)], input_data=json.dumps(run.bridge()))
    finished, = [event for event in events if event['event'] == 'browser_action_finished']
    assert finished['outcome'] == 'unknown'


def test_browser_waits_report_completion_and_timeout_with_durations():
    from treadway import diagnostics
    from treadway.process import run_json_process
    browser = Path(diagnostics.__file__).parent/'browser'
    code = ('const fs=require("fs"),d=require(process.argv[1]+"/diagnostics.js"),'
            '{waitForObservation:wait}=require(process.argv[1]+"/interactions.js"),'
            'c=JSON.parse(fs.readFileSync(0,"utf8"));'
            'd.withDiagnostics(c,async()=>{'
            'await wait("synthetic ready",async()=>true,{windowMs:100});'
            'try{await wait("synthetic pending",async()=>false,{windowMs:20,intervalMs:5});}'
            'catch(e){if(!e.message.startsWith("condition_not_established:"))throw e;}'
            'process.stdout.write("{}");});')
    events = []
    with RunDiagnostics(sinks=[events.append]) as run:
        result = run_json_process(['node', '-e', code, str(browser)], input_data=json.dumps(run.bridge()))
    assert result['failure'] is None
    waits = [event for event in events if event['event'].startswith('browser_wait_')]
    assert [event['event'] for event in waits] == ['browser_wait_started', 'browser_wait_finished']*2
    assert [event['outcome'] for event in waits[1::2]] == ['completed', 'unknown']
    assert all(event['duration_ms'] > 0 for event in waits[1::2])
    assert run.summary()['timings']['browser_wait_finished']['count'] == 2
    assert run.summary()['telemetry_complete']
