"""Native Robot keywords for distinct principals and anonymous sessions."""
import json
import os
from pathlib import Path
import sqlite3

from robot.api.types import Secret

from treadway.browsers import BrowserManager
from treadway.credentials import CredentialResolver
from treadway.process import run_json_process
from treadway.properties import require_expected_fields


class CollaborativeFlow:
    ROBOT_LIBRARY_SCOPE = "SUITE"

    def __init__(self):
        self.config = None
        self.actors = {}

    def open_collaborative_run(self):
        self.config = json.loads(Path(os.environ["TREADWAY_REFERENCE_CONFIG"]).read_text())
        self.manager = BrowserManager(Path(self.config["artifacts"]) / "actors")
        self.identities = CredentialResolver.from_file(Path(__file__).with_name('identities.json'))

    def _open_actor(self, name, expected):
        if name in self.actors:
            raise AssertionError("actor_already_open")
        browser = self.manager.start(name, executable=os.environ["CHROME_BIN"],
                                     sandbox=os.environ.get("TREADWAY_CHROME_SANDBOX", "on") != "off")
        actor = {"name": name, "principal": expected['principal'], "expected": dict(expected),
                 "generation": browser.generation, "connection": browser.connection()}
        self.actors[name] = {"browser": browser, "actor": actor}
        return name

    def open_actor(self, name):
        """Create and verify an independent anonymous session; no credentials."""
        self._open_actor(name, {'principal': None, 'tenant': 'synthetic-team'})
        response = self._request(name, "/api/collaboration/session")
        self._expect(response, 200, {"principal": None})
        return name

    def open_authenticated_actor(self, name, identity, username: Secret, password: Secret):
        """Explicit synthetic login. Unwrap only inside the private helper call."""
        if not isinstance(username, Secret) or not isinstance(password, Secret):
            raise AssertionError('native_robot_secret_required')
        expected = self.identities.identity(identity).expected
        self._open_actor(name, expected)
        response = self._call(name, "login", account=username.value, password=password.value)
        self._expect(response, 200, {"loggedIn": True})
        # Configured labels are expectations; establish the actual principal.
        response = self._request(name, "/api/collaboration/session")
        self._expect(response, 200, dict(expected))
        return name

    def _call(self, name, operation="request", **args):
        entry = self.actors[name]
        with self.manager.drive(entry["browser"]):
            result = run_json_process(["node", str(Path(__file__).with_name("actors.cjs"))],
                input_data=json.dumps({"config": self.config, "actor": entry["actor"], "operation": operation, "args": args}),
                timeout_seconds=12)
        payload = result.get("payload")
        if result["failure"] or result["exitCode"] != 0 or not isinstance(payload, dict) or payload.get("complete") is not True:
            raise AssertionError("actor_operation_incomplete; inspect actors.jsonl; application effect unknown")
        return payload["result"]

    def _request(self, actor, path, method="GET", body=None):
        return self._call(actor, path=path, options={"method": method, **({} if body is None else {"body": body})})

    @staticmethod
    def _expect(response, status, expected):
        if response.get("complete") is not True or response.get("dispatched") is not True or response.get("status") != status:
            raise AssertionError("complete_actual_application_response_required")
        require_expected_fields(response["body"], expected, observation_complete=True, evidence=["actor_response"])

    def create_shared_request(self, actor):
        return self._create(actor, "request")

    def create_private_resource(self, actor):
        return self._create(actor, "private")

    def _create(self, actor, kind):
        response = self._request(actor, "/api/collaboration/resources", "POST", {"run": self.config["run"], "kind": kind})
        self._expect(response, 201, {"creator": self.actors[actor]["actor"]["principal"], "kind": kind})
        value = response["body"]
        return {key: value[key] for key in ("id", "run", "revision", "creator")}

    def _observe(self, resource):
        with sqlite3.connect(Path(self.config["artifacts"]) / "workboard.sqlite") as db:
            row = db.execute("SELECT value FROM resources WHERE id=?", (resource["id"],)).fetchone()
        if row is None:
            raise AssertionError("resource_observation_missing")
        actual = json.loads(row[0])
        require_expected_fields(actual, {"id": resource["id"], "run": self.config["run"]},
                                observation_complete=True, evidence=["independent_sqlite_observer"])
        return actual

    def attempt_self_approval_and_verify_refusal(self, actor, resource):
        before = self._observe(resource)
        response = self._request(actor, "/api/collaboration/resources/" + resource["id"] + "/approve", "POST",
                                 {"run": resource["run"], "revision": resource["revision"]})
        self._expect(response, 403, {"error": "self_approval"})
        if self._observe(resource) != before:
            raise AssertionError("refused_approval_changed_persisted_state")

    def approve_shared_request(self, actor, resource):
        # Re-observe in this actor's browser. The resource reference carries no DOM or credentials.
        path = "/api/collaboration/resources/" + resource["id"]
        current = self._request(actor, path)
        self._expect(current, 200, {"revision": resource["revision"]})
        response = self._request(actor, path + "/approve", "POST",
                                 {"run": resource["run"], "revision": resource["revision"]})
        expected = {"approvedBy": self.actors[actor]["actor"]["principal"], "revision": resource["revision"]+1, "approvalWrites": 1}
        self._expect(response, 200, expected)
        require_expected_fields(self._observe(resource), expected, observation_complete=True, evidence=["independent_sqlite_observer"])
        return {**resource, "revision": response["body"]["revision"]}

    def observe_approved_request(self, actor, resource, approver):
        response = self._request(actor, "/api/collaboration/resources/" + resource["id"])
        self._expect(response, 200, {"approvedBy": self.actors[approver]["actor"]["principal"], "revision": resource["revision"]})

    def verify_private_access(self, actor, resource):
        response = self._request(actor, "/api/collaboration/resources/" + resource["id"])
        self._expect(response, 200, {"id": resource["id"], "content": "Synthetic private content"})

    def attempt_private_access_and_verify_refusal(self, actor, resource):
        before = self._observe(resource)
        principal = self.actors[actor]["actor"]["principal"]
        response = self._request(actor, "/api/collaboration/resources/" + resource["id"])
        self._expect(response, 401 if principal is None else 403,
                     {"error": "authentication_required" if principal is None else "private_resource"})
        if "Synthetic private content" in response["text"] or "content" in response["body"]:
            raise AssertionError("private_content_disclosed")
        if self._observe(resource) != before:
            raise AssertionError("read_attempt_changed_resource")

    def close_collaborative_run(self):
        if self.config is None:
            return
        try:
            with sqlite3.connect(Path(self.config["artifacts"]) / "workboard.sqlite") as db:
                resources = [json.loads(row[0]) for row in db.execute("SELECT value FROM resources")]
            for resource in resources:
                if resource["run"] != self.config["run"]:
                    continue
                owners = [name for name, entry in self.actors.items() if entry["actor"]["principal"] == resource["creator"]]
                if not owners:
                    raise AssertionError("cleanup_owner_session_missing")
                response = self._request(owners[0], "/api/collaboration/resources/" + resource["id"], "DELETE", {"run": resource["run"]})
                self._expect(response, 200, {"deleted": resource["id"]})
            with sqlite3.connect(Path(self.config["artifacts"]) / "workboard.sqlite") as db:
                if db.execute("SELECT count(*) FROM resources").fetchone()[0]:
                    raise AssertionError("collaborative_cleanup_incomplete")
        finally:
            errors = []
            for entry in self.actors.values():
                try:
                    self.manager.stop(entry["browser"])
                except (OSError, RuntimeError) as error:
                    errors.append(str(error))
            self.actors.clear()
            if errors:
                raise AssertionError("browser_cleanup_incomplete: " + "; ".join(errors))
