"""Failure-oriented comparisons for returned application state, no target I/O."""
import copy

import pytest

from treadway.properties import (PrerequisiteNotEstablished, compare_expected_fields,
                             require_expected_fields)


def compare(observed, expected, *, complete=True, evidence=("req-synthetic-observation",)):
    return compare_expected_fields(observed, expected,
                                   observation_complete=complete, evidence=evidence)


def test_order_identity_and_content_are_checked_despite_matching_state_label():
    expected = {"order": {"id": "created-id", "customer_id": "verified-customer",
                                 "state": "submitted", "answer": "submitted value"}}
    actual = {"order": {"id": "different-id", "customer_id": "another-customer",
                               "state": "submitted", "answer": "stale value", "revision": 7}}
    result = compare(actual, expected)
    assert [item["comparison"] for item in result] == ["violated", "violated", "holds", "violated"]
    assert [item["path"] for item in result] == [
        ["order", "id"], ["order", "customer_id"],
        ["order", "state"], ["order", "answer"]]


@pytest.mark.parametrize("status", [200, 400, 403])
def test_transport_status_and_error_body_cannot_supply_missing_application_state(status):
    observed = {"http_status": status, "error": {"message": "required field absent"}}
    result = compare(observed, {"application": {"state": "submitted"}})
    assert result[0]["comparison"] == "inconclusive"
    assert result[0]["reason"] == "field_missing"


def test_missing_field_is_distinct_from_an_observed_null():
    absent = compare({}, {"approval": None})[0]
    null = compare({"approval": None}, {"approval": None})[0]
    assert absent["comparison"] == "inconclusive" and not absent["observed_present"]
    assert null["comparison"] == "holds" and null["observed_present"]


@pytest.mark.parametrize("observed,expected", [
    (True, 1), (1, True), (1, 1.0), ("1", 1),
    ([True], [1]), ({"nested": True}, {"nested": 1}),
])
def test_value_comparison_does_not_silently_coerce_json_types(observed, expected):
    result = compare({"field": observed}, {"field": expected})
    assert result[0]["comparison"] == "violated"


@pytest.mark.parametrize("complete,evidence,reason", [
    (False, ["req-synthetic-observation"], "observation_incomplete"),
    (True, [], "evidence_unavailable"),
])
def test_incomplete_observation_or_missing_evidence_never_produces_a_match(complete, evidence, reason):
    result = compare({"state": "submitted"}, {"state": "submitted"}, complete=complete, evidence=evidence)
    assert result[0]["comparison"] == "inconclusive"
    assert result[0]["reason"] == reason
    assert result[0]["observed"] == "submitted"


def test_incomplete_comparison_retains_a_contrary_observed_value():
    result = compare({"credits": 2}, {"credits": 1}, complete=False)
    assert result[0]["comparison"] == "inconclusive" and result[0]["observed"] == 2


def test_literal_dotted_keys_and_ordered_values_are_preserved():
    result = compare({"answer.4": ["second", "first"]}, {"answer.4": ["first", "second"]})
    assert result[0]["path"] == ["answer.4"] and result[0]["comparison"] == "violated"


def test_references_and_values_are_snapshots_without_mutating_inputs():
    observed, expected = {"values": [1, 2]}, {"values": [1, 2]}
    evidence = ["req-synthetic-observation", "req-synthetic-observation"]
    original = copy.deepcopy((observed, expected, evidence))
    result = compare(observed, expected, evidence=evidence)
    assert (observed, expected, evidence) == original
    observed["values"].append(3)
    expected["values"].append(4)
    evidence.append("req-later")
    assert result[0]["observed"] == result[0]["expected"] == [1, 2]
    assert result[0]["evidence"] == ["req-synthetic-observation"]


@pytest.mark.parametrize("expected", [{}, [], None, {"nested": {1: "invalid-key"}}])
def test_empty_or_invalid_expectations_cannot_silently_pass(expected):
    with pytest.raises(ValueError):
        compare({}, expected)


@pytest.mark.parametrize("evidence", ["req-observation", [None], [""]])
def test_malformed_evidence_references_are_rejected(evidence):
    with pytest.raises(ValueError):
        compare({"field": "value"}, {"field": "value"}, evidence=evidence)


def test_completion_cannot_be_an_implicitly_truthy_string():
    with pytest.raises(ValueError):
        compare({"field": "value"}, {"field": "value"}, complete="false")


def test_required_binding_refuses_wrong_principal_even_with_a_present_identity():
    with pytest.raises(PrerequisiteNotEstablished) as error:
        require_expected_fields(
            {"user": {"id": "wrong-principal"}}, {"user": {"id": "intended-principal"}},
            observation_complete=True, evidence=["req-identity-observer"])
    assert error.value.properties[0]["comparison"] == "violated"
    assert error.value.properties[0]["observed"] == "wrong-principal"
    assert "wrong-principal" not in str(error.value)
    assert "intended-principal" not in str(error.value)


@pytest.mark.parametrize("observed,complete,evidence", [
    ({}, True, ["req-identity-observer"]),
    ({"id": "intended-principal"}, False, ["req-identity-observer"]),
    ({"id": "intended-principal"}, True, []),
])
def test_required_binding_refuses_unestablished_conditions(observed, complete, evidence):
    with pytest.raises(PrerequisiteNotEstablished) as error:
        require_expected_fields(observed, {"id": "intended-principal"},
                                observation_complete=complete, evidence=evidence)
    assert error.value.properties[0]["comparison"] == "inconclusive"


def test_required_binding_returns_properties_only_when_all_selected_fields_hold():
    observed = {"id": "actual-order", "cartId": "intended-cart", "state": "draft"}
    properties = require_expected_fields(
        observed, {"id": "actual-order", "cartId": "intended-cart"},
        observation_complete=True, evidence=["req-draft-observer"])
    assert len(properties) == 2 and all(item["comparison"] == "holds" for item in properties)


def test_required_binding_checks_every_required_relationship():
    with pytest.raises(PrerequisiteNotEstablished) as error:
        require_expected_fields(
            {"id": "actual-order", "cartId": "wrong-cart"},
            {"id": "actual-order", "cartId": "intended-cart"},
            observation_complete=True, evidence=["req-draft-observer"])
    assert [item["comparison"] for item in error.value.properties] == ["holds", "violated"]
