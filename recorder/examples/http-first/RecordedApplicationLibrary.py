"""Adapter for the local capture-to-HTTP fixture, not arbitrary applications."""
import json
from pathlib import Path
from urllib.parse import urlsplit

from treadway.sessions import HttpSession


class RecordedApplicationLibrary:
    ROBOT_LIBRARY_SCOPE = "TEST"

    def configure_recorded_application(self, origin, capture_path, actor, credential_actor=None):
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("local_fixture_required")
        capture = json.loads(Path(capture_path).read_text())
        fields = {}
        for event in capture["events"]:
            if event["type"] != "fill":
                continue
            for entry in event["filled"]:
                if entry.get("retained") and entry.get("field", {}).get("name") in {"given_name", "family_name", "application_note"}:
                    fields[entry["field"]["name"]] = entry["observedValue"]
        if set(fields) != {"given_name", "family_name", "application_note"}:
            raise AssertionError("captured_field_mapping_incomplete")
        saves = [event for event in capture["events"] if event["type"] == "network_response"
                 and event.get("method") == "POST" and urlsplit(event["url"]).path == "/api/applications"
                 and event.get("status") == 201]
        if len(saves) != 1 or capture["handoff"]["requestBodies"] != "not_captured_by_recorder":
            raise AssertionError("recorded_application_save_incomplete")
        # This mapping is calibrated against the local fixture's HTML/submit
        # source. Metadata alone is not claimed to reveal an arbitrary API body.
        self.body, self.actor = fields, actor
        self.session = HttpSession(actor=actor, origin=origin, credential_headers=lambda: {
            "Cookie": "fixture_actor=" + (credential_actor or actor),
        })

    def create_recorded_application_once(self):
        response = self.session.attempt("/api/applications", method="POST", body=self.body,
                                        probe="/api/me", expected={"id": self.actor, "role": "participant"})
        if response.status != 201 or not response.complete:
            raise AssertionError("create_unconfirmed_no_automatic_retry")
        identifier = response.json().get("id")
        if not isinstance(identifier, str) or not identifier.startswith("application-"):
            raise AssertionError("resource_binding_incomplete")
        return {"id": identifier, "owner": self.actor, **self.body}

    def observe_recorded_application(self, expected):
        with self.session.observation_only():
            response = self.session.request("/api/applications/" + expected["id"])
        if response.status != 200 or not response.complete or response.json() != expected:
            raise AssertionError("persisted_application_differs")
