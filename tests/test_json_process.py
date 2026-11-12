import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from treadway.process import run_json_process, require_completed_process, JsonProcessIncomplete


class JsonProcessChecks(unittest.TestCase):
    def test_progress_callback_is_delivered_before_child_can_finish(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            acknowledgement = Path(directory) / "ack"
            source = """import json,pathlib,sys,time
print('phase-started',file=sys.stderr,flush=True)
p=pathlib.Path(sys.argv[1])
while not p.exists(): time.sleep(.01)
print(json.dumps({'finished':True}))
"""
            lines = []
            def progress(line):
                lines.append(line)
                acknowledgement.write_text("received")
            result = run_json_process([sys.executable, "-c", source, str(acknowledgement)],
                                      on_stderr=progress, timeout_seconds=3)
            self.assertIsNone(result["failure"])
            self.assertEqual(result["payload"], {"finished": True})
            self.assertEqual(lines, ["phase-started"])

    def test_large_stdin_and_stderr_are_not_competing_with_stdout(self):
        value = {"text": "x" * 200000}
        source = """import json,sys
data=json.load(sys.stdin)
for i in range(100): print('phase-'+str(i),file=sys.stderr)
print(json.dumps({'length':len(data['text'])}))
"""
        result = run_json_process([sys.executable, "-c", source], input_data=json.dumps(value))
        self.assertIsNone(result["failure"])
        self.assertEqual(result["payload"], {"length": 200000})
        self.assertEqual(len(result["stderrLines"]), 100)

    def test_timeout_retains_unknown_outcome_and_captured_progress(self):
        result = run_json_process([sys.executable, "-c", "import sys,time;print('dispatched',file=sys.stderr,flush=True);time.sleep(30)"], timeout_seconds=.3)
        self.assertEqual(result["failure"], "process_deadline")
        self.assertIn("dispatched", result["stderrLines"])
        self.assertIsNone(result["payload"])

    def test_valid_json_is_retained_even_when_process_exits_nonzero(self):
        result = run_json_process([sys.executable, "-c", "import sys;print('{\"effect\":true}');sys.exit(2)"])
        self.assertEqual(result["failure"], "nonzero_exit")
        self.assertEqual(result["payload"], {"effect": True})
        with self.assertRaises(JsonProcessIncomplete) as error:
            require_completed_process(result)
        self.assertIs(error.exception.result, result)
        self.assertTrue(error.exception.result["payload"]["effect"])

    def test_positive_report_cannot_override_an_incomplete_runner(self):
        for failure in ("process_deadline", "nonzero_exit", "invalid_json_output"):
            result = {"failure": failure, "exitCode": 2, "payload": {"observed": True}}
            with self.assertRaises(JsonProcessIncomplete):
                require_completed_process(result)

    def test_completed_runner_returns_its_actual_payload(self):
        payload = {"observed": True, "http_status": 403}
        self.assertIs(require_completed_process({"failure": None, "exitCode": 0, "payload": payload}), payload)

    def test_malformed_output_does_not_become_success(self):
        result = run_json_process([sys.executable, "-c", "print('not JSON')"])
        self.assertEqual(result["failure"], "invalid_json_output")

    def test_callback_failure_is_visible_and_does_not_discard_result(self):
        def fail(line):
            raise RuntimeError("fixture reporting failure")
        result = run_json_process([sys.executable, "-c", "import sys;print('phase',file=sys.stderr);print('{}')"], on_stderr=fail)
        self.assertIsNone(result["failure"])
        self.assertEqual(result["progressErrors"], ["RuntimeError"])
        self.assertEqual(result["payload"], {})


if __name__ == "__main__":
    unittest.main()


def test_nonfinite_deadline_rejected_before_start():
    import pytest
    for value in (float('nan'), float('inf'), True):
        with pytest.raises(ValueError):
            run_json_process(['unused'], timeout_seconds=value)


def test_descendant_holding_pipes_cannot_extend_deadline():
    import os
    import time
    import pytest
    if os.name != 'posix':
        pytest.skip('POSIX process group contract')
    started = time.monotonic()
    result = run_json_process([sys.executable, '-c',
        'import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); print("{\\\"effect\\\":true}",flush=True)'],
        # Allow interpreter startup under a loaded CI worker; the descendant
        # still holds the pipes for far longer than the three-second bound.
        timeout_seconds=1)
    assert time.monotonic() - started < 3
    assert result['failure'] == 'process_deadline'
    assert result['payload'] == {'effect': True}
