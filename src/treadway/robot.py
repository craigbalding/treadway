"""Thin Robot adapter for form-assessor.js; application observers stay with the flow."""
from __future__ import annotations

import json
from pathlib import Path
from .process import run_json_process


class FormOperationIncomplete(RuntimeError):
    """Required mechanics failed; retain observations without printing field data."""

    def __init__(self, operation, result, transport):
        self.result = result
        self.transport = transport
        super().__init__(f"Form {operation} incomplete; inspect exception.result or Get Last Form Result")


class FormLibrary:
    ROBOT_LIBRARY_SCOPE = "SUITE"

    def __init__(self, cdp_host, cdp_port, target_id, record_path, scope="body", frame_selector=None):
        self.configuration = dict(cdpHost=cdp_host, cdpPort=int(cdp_port),
                                  targetId=target_id, recordPath=str(record_path), scope=scope,
                                  frameSelector=frame_selector)
        self.record_path = Path(record_path)

    def _run(self, operation, **arguments):
        command = ["node", str(Path(__file__).with_name("browser") / "form-assessor.js")]
        from robot.api import logger
        transport = run_json_process(command,
            input_data=json.dumps(dict(self.configuration, operation=operation, **arguments)),
            on_stderr=lambda line: logger.console("Form: " + line), timeout_seconds=65)
        result = transport["payload"]
        self.last_result = result
        self.last_transport = transport
        valid = isinstance(result, dict)
        if valid and operation == "inspect":
            valid = result.get("observed") is True
        elif valid and operation == "locate":
            valid = (isinstance(result.get('snapshot'), dict) and result['snapshot'].get('observed') is True
                     and isinstance(result.get('item'), dict) and bool(result['item'].get('ref')))
        elif valid and operation == "apply":
            valid = result.get("complete") is True and result.get("recordStatus") == "recorded"
        elif valid and operation == "attempt":
            valid = (result.get("actionDispatch") == "dispatched"
                     and result.get("browserResponsive") is True
                     and isinstance(result.get("after"), dict)
                     and result["after"].get("observed") is True
                     and not result.get("observerError")
                     and result.get("recordStatus") == "recorded")
        if transport["failure"] is not None or transport["exitCode"] != 0 or not valid:
            raise FormOperationIncomplete(operation, result, transport)
        return result

    def get_last_form_result(self):
        """Retain full operation and transport evidence even when a keyword fails."""
        return {"result": getattr(self, "last_result", None),
                "transport": getattr(self, "last_transport", None),
                "recordPath": str(self.record_path)}

    def inspect_form(self, redact_values: bool = False):
        """Observe actions first, fields, validation, choices and in-page dialogs."""
        return self._run("inspect", redactValues=redact_values)

    def locate_form_control(self, selector, kind="action"):
        """Bind a calibrated selector to one observed action or field; never choose first."""
        return self._run("locate", selector=selector, kind=kind)

    def apply_form_candidates(self, snapshot, candidates):
        """Apply sourced candidates with actual input and verified DOM readback."""
        return self._run("apply", snapshot=snapshot, candidates=candidates)

    def attempt_form_action(self, snapshot, action_ref, window_ms=1500, intent="action", field_ref=None):
        """One action, bounded observation, durable intent/result; no implicit retry."""
        return self._run("attempt", snapshot=snapshot, actionRef=action_ref,
                         windowMs=int(window_ms), intent=intent, fieldRef=field_ref)

    def get_form_action(self, snapshot, exact_label):
        """Select an exact, unique visible label. Never prefer submit or first match."""
        matches = [a for a in snapshot["actions"] if a["visible"] and a["label"] == exact_label]
        if len(matches) != 1:
            raise AssertionError(f"Action label must identify exactly one visible action: {exact_label!r}")
        if matches[0]["disabled"]:
            raise AssertionError(f"Action is disabled: {exact_label!r}")
        return matches[0]

    def read_form_attempt_history(self, last=10):
        """Recall local input plans/results and action intents/results, including unknowns."""
        count = int(last)
        if count < 1 or count > 100:
            raise ValueError("last must be 1..100")
        if not self.record_path.exists():
            return {"entries": [], "incompleteTrailingRecord": False}
        entries, incomplete = [], False
        with self.record_path.open() as handle:
            lines = handle.readlines()
        for i, line in enumerate(lines):
            try:
                entries.append(json.loads(line))
            except ValueError:
                if i != len(lines) - 1:
                    raise ValueError("Malformed attempt record before final line") from None
                incomplete = True
        return {"entries": entries[-count:], "incompleteTrailingRecord": incomplete}
