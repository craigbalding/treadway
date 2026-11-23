"""Calibrated adapter for the synthetic fixture; construction is passive."""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from treadway.sessions import HttpSession


class ClaimLibrary:
    ROBOT_LIBRARY_SCOPE = "TEST"

    def configure_fixture(self, origin, actor, credential_actor=None):
        # This example's invented authentication must never reach a real app.
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("local_fixture_required")
        self.actor = actor
        self.session = HttpSession(actor=actor, origin=origin, credential_headers=lambda: {
            "X-Fixture-Actor": credential_actor or actor,
        })

    def verify_capture_mapping(self):
        bundle = json.loads(Path(__file__).with_name("capture.json").read_text())
        events = bundle["recording"]["events"]
        flows = {flow["id"]: flow for flow in bundle["flowProjections"]}
        responses = [event for event in events if event["type"] == "network_response"]
        if {event["safeyoloRequestId"] for event in responses} != set(flows):
            raise AssertionError("capture_join_incomplete")
        for event in responses:
            flow = flows[event["safeyoloRequestId"]]
            if (event["method"], event["url"], event["status"]) != (
                flow["method"], flow["url"], flow["status"]
            ):
                raise AssertionError("capture_join_differs")
        if flows["req-synthetic-save"]["responseJson"]["id"] != "claim-captured":
            raise AssertionError("captured_resource_mapping_differs")

    def create_claim_once(self, amount):
        body = {"amount": int(amount), "currency": "EUR"}

        def prerequisite():
            if body["amount"] <= 0:
                raise ValueError("positive_amount_required")

        # The actual HTTP session is probed inside this dependent operation.
        # Deliberate auth/validation tests should use their own explicit operation.
        response = self.session.attempt(
            "/api/claims", method="POST", body=body,
            probe="/api/me", expected={"id": self.actor, "role": "submitter"},
            before_dispatch=prerequisite,
        )
        if response.status != 201 or not response.complete:
            raise AssertionError("create_unconfirmed_reconcile_before_any_retry")
        resource_id = response.json().get("id")
        if not isinstance(resource_id, str) or not re.fullmatch(r"claim-[a-z0-9-]+", resource_id):
            raise AssertionError("resource_binding_unconfirmed")
        return {"id": resource_id, "owner": self.actor, **body}

    def observe_persisted_claim(self, expected):
        # A separate fresh read proves persistence, beyond POST acceptance.
        with self.session.observation_only():
            response = self.session.request("/api/claims/" + expected["id"])
        if response.status != 200 or not response.complete or response.json() != expected:
            raise AssertionError("persistence_unconfirmed")
        return response.json()
