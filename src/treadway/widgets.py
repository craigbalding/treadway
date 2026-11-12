"""Native Robot keywords for shared widget mechanics; no application verdicts."""
from __future__ import annotations

import json
from pathlib import Path

from .process import run_json_process


class WidgetOperationIncomplete(RuntimeError):
    def __init__(self, operation, result, transport):
        self.result = result
        self.transport = transport
        super().__init__(f"Widget {operation} incomplete; inspect Get Last Widget Result")


class WidgetLibrary:
    ROBOT_LIBRARY_SCOPE = "SUITE"

    def __init__(self, cdp_host, cdp_port, target_id, origin, record_path, kind,
                 profile, scope="body", frame_selector=None):
        if isinstance(profile, str):
            profile = json.loads(profile)
        if not isinstance(profile, dict):
            raise ValueError("Widget profile must be a mapping")
        if kind not in {"autocomplete", "multi_select", "date_range", "rich_text",
                        "inline_editor", "prepared_edit"}:
            raise ValueError("Unknown widget kind")
        self.configuration = dict(cdpHost=cdp_host, cdpPort=int(cdp_port),
                                  targetId=target_id, origin=origin,
                                  recordPath=str(record_path), kind=kind,
                                  profile=profile, scope=scope,
                                  frameSelector=frame_selector)
        self.record_path = Path(record_path)

    def _run(self, operation, **arguments):
        from robot.api import logger
        transport = run_json_process(
            ["node", str(Path(__file__).with_name("browser") / "widget-runner.js")],
            input_data=json.dumps(dict(self.configuration, operation=operation,
                                       arguments=arguments)),
            on_stderr=lambda line: logger.console("Widget: " + line),
            timeout_seconds=65)
        envelope = transport["payload"]
        self.last_result = envelope
        self.last_transport = transport
        valid = (isinstance(envelope, dict)
                 and envelope.get("version") == "treadway.widget/1"
                 and envelope.get("mechanicsComplete") is True
                 and isinstance(envelope.get("result"), dict))
        result = envelope.get("result") if isinstance(envelope, dict) else None
        if valid and operation in {"inspect", "open"}:
            valid = result.get("observed") is True
        elif valid and operation == "prepare_edit":
            valid = (result.get("version") == "treadway.edit/1"
                     and isinstance(result.get("fields"), list)
                     and bool(result["fields"])
                     and bool(result.get("actionRef")))
        elif valid and operation == "prepare_choice":
            valid = (result.get("version") == "treadway.choice/1"
                     and bool(result.get("fieldRef"))
                     and isinstance(result.get("snapshot"), dict)
                     and result["snapshot"].get("observed") is True)
        elif valid and operation in {"commit_edit", "select_choice", "remove_choice"}:
            receipt = result.get("receipt")
            valid = (isinstance(receipt, dict)
                     and receipt.get("actionDispatch") == "dispatched"
                     and receipt.get("recordStatus") == "recorded"
                     and not receipt.get("browserDialog")
                     and (arguments.get("allowTransition") is True
                          or isinstance(receipt.get("after"), dict)
                          and receipt["after"].get("observed") is True))
        if transport["failure"] is not None or transport["exitCode"] != 0 or not valid:
            raise WidgetOperationIncomplete(operation, envelope, transport)
        return result

    def inspect_widget(self):
        """Observe the current document before choosing a component operation."""
        return self._run("inspect")

    def open_inline_widget(self, snapshot, source):
        """Explicitly open the configured inline editor; never infer this step."""
        return self._run("open", snapshot=snapshot, source=source)

    def prepare_widget_inputs(self, snapshot, values, source):
        """Prepare sourced values; return a binding for a separate commit."""
        return self._run("prepare_edit", snapshot=snapshot, values=values, source=source)

    def commit_widget_edit(self, prepared, window_ms=600, allow_transition: bool = False):
        """Recheck native targets and retained values before one explicit action."""
        return self._run("commit_edit", prepared=prepared, windowMs=int(window_ms),
                         allowTransition=allow_transition)

    def prepare_widget_choice(self, snapshot, source, query=None, exact_label=None,
                              open_choices: bool = False):
        arguments = dict(snapshot=snapshot, source=source, open=open_choices)
        if query is not None:
            arguments["query"] = query
        if exact_label is not None:
            arguments["label"] = exact_label
        return self._run("prepare_choice", **arguments)

    def select_widget_option(self, prepared, exact_label, option_selector=None,
                             before=None, after=None, window_ms=500):
        arguments = dict(prepared=prepared, label=exact_label, windowMs=int(window_ms))
        if option_selector is not None:
            arguments["optionSelector"] = option_selector
        if before is not None:
            arguments["before"] = before
        if after is not None:
            arguments["after"] = after
        return self._run("select_choice", **arguments)

    def remove_widget_selection(self, value, before, after, source):
        return self._run("remove_choice", id=value, before=before, after=after, source=source)

    def get_last_widget_result(self):
        """Retain incomplete mechanics and transport separately from persistence."""
        return {"result": getattr(self, "last_result", None),
                "transport": getattr(self, "last_transport", None),
                "recordPath": str(self.record_path)}
