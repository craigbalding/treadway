"""Domain keywords for the synthetic workboard. Imports/constructors are passive."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from treadway.process import run_json_process
from treadway.properties import require_expected_fields


class ReferenceFlow:
    ROBOT_LIBRARY_SCOPE = "SUITE"

    def __init__(self):
        self.config = None
        self.bindings = {}
        self.last = None

    def open_reference_run(self):
        self.config = json.loads(Path(os.environ["TREADWAY_REFERENCE_CONFIG"]).read_text())
        self.journal = Path(self.config["artifacts"]) / "domain.jsonl"

    def _record(self, value):
        with self.journal.open("a") as stream:
            stream.write(json.dumps(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def _http(self, path, body=None, method=None):
        request = Request(self.config["origin"] + path,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Content-Type": "application/json"}, method=method)
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def _browser(self, operation, **args):
        from robot.api import logger
        transport = run_json_process(
            ["node", str(Path(__file__).with_name("browser.cjs"))],
            input_data=json.dumps({"config": self.config, "operation": operation, "args": args}),
            timeout_seconds=25, on_stderr=lambda line: logger.console("Reference: " + line))
        self.last = transport
        self._record({"operation": operation, "transport": transport})
        payload = transport.get("payload")
        if transport["failure"] or transport["exitCode"] != 0 or not isinstance(payload, dict) or payload.get("complete") is not True:
            message = payload.get("error", "no complete result") if isinstance(payload, dict) else "no result"
            raise AssertionError(f"{operation} incomplete: {message}; effects require observation")
        return payload["result"]

    def _issued(self, binding):
        if self.bindings.get(binding.get("id")) != binding:
            raise AssertionError("issued_current_binding_required")

    def create_work_item(self, title):
        binding = self._browser("create", title=title)
        if binding.get("run") != self.config["run"] or binding.get("actor") != "fixture-author":
            raise AssertionError("created_resource_scope_differs")
        self.bindings[binding["id"]] = copy.deepcopy(binding)
        self._record({"kind": "created_binding", "binding": binding})
        return binding

    def prepare_work_item_plan(self, binding, owner, start, due, note):
        self._issued(binding)
        return self._browser("prepare", binding=binding, owner=owner, start=start, due=due, note=note)

    def commit_work_item_plan(self, plan):
        binding = plan["binding"]
        self._issued(binding)
        actual = self._browser("commit", binding=binding, plan=plan)
        self.bindings[actual["id"]] = copy.deepcopy(actual)
        self.verify_work_item(actual, plan["expected"])
        return actual

    def verify_work_item(self, binding, expected):
        self._issued(binding)
        status, actual = self._http("/api/items/" + binding["id"])
        self._record({"kind": "independent_sqlite_observation", "status": status, "actual": actual, "expected": expected})
        if status != 200 or actual.get("run") != self.config["run"]:
            raise AssertionError("bound_resource_observation_incomplete")
        require_expected_fields(actual, {"id": binding["id"], "revision": binding["revision"], **expected},
                                observation_complete=True, evidence=[str(self.journal)])
        return actual

    def reload_and_verify_work_item(self, binding, expected):
        self._issued(binding)
        actual = self._browser("reload", binding=binding)
        self._record({"kind": "reloaded_ui_observation", "actual": actual, "expected": expected})
        require_expected_fields(actual, expected, observation_complete=True,
                                evidence=[str(self.journal)])
        return self.verify_work_item(binding, expected)

    def advance_fixture_revision(self, binding):
        """Explicit competing writer for the stale-binding demonstration."""
        self._issued(binding)
        status, actual = self._http("/api/items/" + binding["id"] + "/advance",
                                    {"run": self.config["run"]}, "POST")
        if status != 200 or actual["revision"] != binding["revision"] + 1:
            raise AssertionError("competing_write_not_established")
        self._record({"kind": "competing_writer", "actual": actual})
        return actual

    def verify_no_plan_write(self, binding, expected_revision):
        status, actual = self._http("/api/items/" + binding["id"])
        if status != 200 or actual["revision"] != int(expected_revision) or actual["writes"] != 0:
            raise AssertionError("no_plan_write_not_established")
        self._record({"kind": "stale_guard_effect_observed", "actual": actual})

    def cleanup_reference_items(self):
        if self.config is None:
            return
        # Recover actual IDs recorded before an interrupted create returned to Python.
        attempts = Path(self.config["artifacts"]) / "attempts.jsonl"
        if attempts.exists():
            for line in attempts.read_text().splitlines():
                entry = json.loads(line)
                if entry.get("kind") == "resource_created":
                    binding = entry["binding"]
                    if binding.get("run") == self.config["run"]:
                        self.bindings.setdefault(binding["id"], binding)
        outcomes = []
        for binding in self.bindings.values():
            before, _ = self._http("/api/items/" + binding["id"])
            status = None
            if before == 200:
                status, _ = self._http("/api/items/" + binding["id"], {"run": self.config["run"]}, "DELETE")
            elif before != 404:
                raise AssertionError("cleanup_resource_observation_incomplete")
            observed, _ = self._http("/api/items/" + binding["id"])
            outcomes.append({"id": binding["id"], "deleteStatus": status, "absent": observed == 404})
        self._record({"kind": "cleanup", "outcomes": outcomes})
        if not all(item["deleteStatus"] in {None, 200} and item["absent"] for item in outcomes):
            raise AssertionError("cleanup_incomplete")
        self.bindings.clear()
