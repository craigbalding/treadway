"""Small, dependency-free comparisons for calibrated application evaluators.

Expected values should come from the operation's actual actor/resource/input
bindings. Callers select the fields and establish that their observer reached
the completion condition relevant to that comparison. This module does not
verify those bindings, interpret HTTP responses, or choose expected behavior.
Results are observation properties for a consuming application to interpret.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import copy
import json


EVALUATOR_VERSION = "treadway.expected-fields/1"
_MISSING = object()


class PrerequisiteNotEstablished(RuntimeError):
    """An operation cannot return a usable context under these observations.

    Full properties remain available for recording; the exception message
    contains only field paths/reasons, not observed values or credentials.
    This reports an unestablished workflow prerequisite, not application success.
    """

    def __init__(self, properties):
        self.properties = copy.deepcopy(properties)
        unresolved = [item for item in properties if item["comparison"] != "holds"]
        details = ", ".join(
            repr(item["path"]) + ": " + item["reason"] for item in unresolved)
        super().__init__("Required observed fields are not established: " + details)


def _same_value(actual, expected):
    """Preserve JSON types, including bool versus int, throughout containers."""
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(
            _same_value(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _same_value(left, right) for left, right in zip(actual, expected))
    return actual == expected


def compare_expected_fields(observed, expected, *, observation_complete, evidence):
    """Compare an expected JSON-object subset against an observed JSON object.

    Nonempty nested expected objects select fields recursively. Lists and empty
    objects are exact values. Keys are literal, so a field named ``a.b`` is not
    interpreted as a path. Missing data, incomplete observation, or absent
    evidence produces inconclusive properties rather than a match. Even an
    inconclusive property retains any supplied observation for investigation.

    ``evidence`` contains existing request IDs/artifact references supplied by
    the observer. This pure function preserves references; the consumer is
    responsible for resolving and validating them. Completion must be explicit
    and is specific to the fields/claim, not a generic HTTP-success flag.
    """
    if not isinstance(expected, dict) or not expected:
        raise ValueError("expected must select at least one application field")
    # Validate expectations, without coercing observed values or test stimuli.
    json.dumps(expected, allow_nan=False)
    if type(observation_complete) is not bool:
        raise ValueError("observation_complete must be an explicit boolean")
    if isinstance(evidence, (str, bytes)) or not isinstance(evidence, Sequence):
        raise ValueError("evidence must be a sequence of observer references")
    if any(not isinstance(ref, str) or not ref.strip() for ref in evidence):
        raise ValueError("each evidence reference must be nonempty text")
    references = list(dict.fromkeys(evidence))
    results = []

    def compare(actual, wanted, path):
        if isinstance(wanted, dict) and wanted:
            for key, value in wanted.items():
                if not isinstance(key, str):
                    raise ValueError("expected field names must be strings")
                child = actual.get(key, _MISSING) if isinstance(actual, Mapping) else _MISSING
                compare(child, value, path + [key])
            return
        present = actual is not _MISSING
        reason = (
            "observation_incomplete" if not observation_complete else
            "evidence_unavailable" if not references else
            "field_missing" if not present else
            "matches" if _same_value(actual, wanted) else "differs"
        )
        results.append({
            "path": path,
            "expected": copy.deepcopy(wanted),
            "observed": copy.deepcopy(actual) if present else None,
            "observed_present": present,
            "comparison": {"matches": "holds", "differs": "violated"}.get(reason, "inconclusive"),
            "reason": reason,
            "evidence": references.copy(),
            "evaluator_version": EVALUATOR_VERSION,
        })

    compare(observed, expected, [])
    return results


def require_expected_fields(observed, expected, *, observation_complete, evidence):
    """Require established bindings inside an operation, retaining properties.

    Call this before returning an actor/resource context or issuing an action
    that depends on the selected fields. A wrong/missing value, unavailable
    evidence or incomplete observer refuses the operation. Do not merely emit
    several booleans and rely on a scenario author to combine them correctly.

    Expectations must come from independent configured/runtime bindings, not
    a copy of this observation. Apply this to workflow prerequisites; do not
    require the behavior being evaluated to hold before evaluating it.
    The calibrated caller still establishes that the observer is authoritative
    for the selected fields and interprets their domain meaning.
    """
    properties = compare_expected_fields(
        observed, expected, observation_complete=observation_complete,
        evidence=evidence)
    if any(item["comparison"] != "holds" for item in properties):
        raise PrerequisiteNotEstablished(properties)
    return properties
