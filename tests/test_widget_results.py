import json
from unittest.mock import Mock

import pytest

from treadway import widgets


def library():
    return widgets.WidgetLibrary('127.0.0.1', 1, 'synthetic-target',
        'http://synthetic.invalid', '/tmp/synthetic-unused.jsonl', 'prepared_edit',
        {'fields': {'title': {'selector': '#title'}}, 'action': {'selector': '#save'}})


def transport(result, *, complete=True, exit_code=0):
    return {'payload': {'version': 'treadway.widget/1', 'mechanicsComplete': complete,
                        'result': result}, 'failure': None, 'exitCode': exit_code}


def test_widget_constructor_has_no_transport_effect(monkeypatch):
    runner = Mock(side_effect=AssertionError('unexpected transport'))
    monkeypatch.setattr(widgets, 'run_json_process', runner)
    library()
    runner.assert_not_called()


def test_incomplete_widget_receipt_blocks_and_retains_full_result(monkeypatch):
    observed = transport({'receipt': {'actionDispatch': 'dispatched', 'recordStatus': 'recorded'}})
    monkeypatch.setattr(widgets, 'run_json_process', Mock(return_value=observed))
    widget = library()
    with pytest.raises(widgets.WidgetOperationIncomplete) as failure:
        widget.commit_widget_edit({'synthetic': 'prepared'})
    assert failure.value.transport is observed
    assert widget.get_last_widget_result()['result'] is observed['payload']


def test_only_explicit_transition_can_accept_unobserved_after_state(monkeypatch):
    observed = transport({'receipt': {'actionDispatch': 'dispatched', 'recordStatus': 'recorded',
                                      'after': {'observed': False}}})
    monkeypatch.setattr(widgets, 'run_json_process', Mock(return_value=observed))
    widget = library()
    with pytest.raises(widgets.WidgetOperationIncomplete):
        widget.commit_widget_edit({'synthetic': 'prepared'})
    assert widget.commit_widget_edit({'synthetic': 'prepared'}, allow_transition=True)['receipt']['after']['observed'] is False


def test_runner_error_never_becomes_a_successful_widget_result(monkeypatch):
    observed = transport({'version': 'treadway.edit/1', 'fields': [{'ref': 'field'}],
                          'actionRef': 'save'}, exit_code=1)
    monkeypatch.setattr(widgets, 'run_json_process', Mock(return_value=observed))
    with pytest.raises(widgets.WidgetOperationIncomplete):
        library().prepare_widget_inputs({}, {'title': 'Synthetic'}, 'explicit synthetic input')


def test_widget_values_and_sources_are_not_repaired_or_normalized(monkeypatch):
    runner = Mock(return_value=transport({}, complete=False))
    monkeypatch.setattr(widgets, 'run_json_process', runner)
    values = {'title': '  Synthetic café <b>literal</b>  '}
    with pytest.raises(widgets.WidgetOperationIncomplete):
        library().prepare_widget_inputs({'observed': True}, values, 'explicit synthetic source')
    sent = json.loads(runner.call_args.kwargs['input_data'])
    assert sent['arguments']['values'] == values
    assert sent['arguments']['source'] == 'explicit synthetic source'
    assert sent['operation'] == 'prepare_edit'
