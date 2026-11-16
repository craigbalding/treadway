"""Optional native Robot listener: one diagnostics owner for the outer suite."""
from pathlib import Path
import time

from .diagnostics import RunDiagnostics, RobotSink, reference


class DiagnosticsListener:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self, output='artifacts/diagnostics', level='INFO', guard_runtime='false', flow_files=''):
        # Robot import and dry-run are passive. Configuration is used at suite start.
        self.output, self.level = output, level
        self.guard_runtime = str(guard_runtime).lower() == 'true'
        self.flow_files = [Path(value) for value in flow_files.split(',') if value]
        self.run = None
        self._depth = 0
        self._keywords = []
        self._robot_sink = None

    def start_suite(self, data, result):
        # Robot's public OPTIONS variable omits dry-run. This compatibility point
        # is covered against the project's pinned Robot 7.5.1 runtime.
        from robot.running.context import EXECUTION_CONTEXTS
        if EXECUTION_CONTEXTS.current.dry_run:
            return
        if self._depth == 0:
            self._robot_sink = RobotSink(console=True, level=self.level)
            self.run = RunDiagnostics(Path(self.output), sinks=[self._robot_sink],
                                      level=self.level, watch_runtime=self.guard_runtime, watch=self.flow_files)
            self.run.__enter__()
        self._depth += 1

    def end_suite(self, data, result):
        if self.run is None:
            return
        self._depth -= 1
        if self._depth == 0:
            self.run.__exit__(None if result.passed else AssertionError,
                              None if result.passed else AssertionError('suite_failed'), None)
            self._robot_sink.flush()

    def start_test(self, data, result):
        if self.run:
            self.run.emit('test_started', target_ref=reference(data.name))

    def end_test(self, data, result):
        if self.run:
            self.run.emit('test_finished', target_ref=reference(data.name),
                          outcome='completed' if result.passed else 'failed')

    def start_keyword(self, data, result):
        if self.run:
            self._keywords.append(time.monotonic())
            self.run.emit('keyword_started', level='DEBUG', target_ref=reference(data.name))

    def end_keyword(self, data, result):
        if self.run and self._keywords:
            self.run.emit('keyword_finished', level='DEBUG', target_ref=reference(data.name),
                          duration_ms=(time.monotonic()-self._keywords.pop())*1000,
                          outcome='completed' if result.passed else 'failed')
            self._robot_sink.flush()

    def close(self):
        if self.run and self._depth:
            self._depth = 0
            self.run.__exit__(KeyboardInterrupt, KeyboardInterrupt(), None)
            self._robot_sink.flush()
