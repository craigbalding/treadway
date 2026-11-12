"""Mechanical failures stop composition; application validation remains evidence."""
from unittest.mock import patch
import pytest
from treadway.robot import FormLibrary, FormOperationIncomplete


def transport(payload, **overrides):
    return dict(payload=payload, failure=None, exitCode=0, stderrLines=['phase'], progressErrors=[], **overrides)


@pytest.mark.parametrize('operation,payload', [
    ('inspect', {'observed': False}),
    ('inspect', None),
    ('locate', {'snapshot': {'observed': True}, 'item': {}}),
    ('apply', {'complete': False, 'receipts': [{'applied': False}]}),
    ('apply', {'complete': True, 'recordStatus': 'result_write_failed'}),
    ('attempt', {'actionDispatch': 'attempted', 'completion': 'unconfirmed'}),
    ('attempt', {'actionDispatch': 'dispatched', 'browserDialog': {'type': 'alert'}}),
])
def test_incomplete_operation_raises_and_retains_all_evidence(operation, payload):
    lib = FormLibrary('127.0.0.1', 1, 'fixture', '/tmp/synthetic-unused')
    result = transport(payload)
    with patch('treadway.robot.run_json_process', return_value=result):
        with pytest.raises(FormOperationIncomplete) as caught:
            lib._run(operation)
    assert caught.value.result is payload
    assert caught.value.transport is result
    assert lib.get_last_form_result()['transport'] is result


@pytest.mark.parametrize('operation,payload', [
    ('inspect', {'observed': True}),
    ('apply', {'complete': True, 'recordStatus': 'recorded'}),
    ('attempt', {'actionDispatch': 'dispatched', 'browserResponsive': True, 'after': {'observed': True},
                 'recordStatus': 'recorded', 'diagnosis': 'validation_feedback_present', 'completion': 'unconfirmed'}),
])
def test_successful_mechanics_pass_including_application_validation(operation, payload):
    lib = FormLibrary('127.0.0.1', 1, 'fixture', '/tmp/synthetic-unused')
    result = transport(payload)
    with patch('treadway.robot.run_json_process', return_value=result):
        assert lib._run(operation) is payload
    result['failure'] = 'process_deadline'
    with patch('treadway.robot.run_json_process', return_value=result):
        with pytest.raises(FormOperationIncomplete):
            lib._run(operation)
