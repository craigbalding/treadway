"""Public CI summaries cannot carry private browser capabilities or raw captures."""
from pathlib import Path
import json
import runpy


def test_ci_summary_allowlists_public_fields_and_drops_raw_evidence():
    module = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/test_browserserve_docker.py'))
    secret = 'synthetic-capability-must-stay-private'
    result = module['public_summary']({'passed': True, 'containerRemoved': True, 'durationSeconds': 12.5,
        'endpoint': 'ws://browser.example.invalid/?resume='+secret, 'token': secret,
        'rawJournal': secret, 'acceptance': {'rawEvidence': secret,
            'finalPressure': {'running': 0, 'parked': 0, 'reason': secret, 'token': secret}}})
    assert secret not in json.dumps(result)
    assert result['passed'] is True and result['finalSessions'] == {'running': 0, 'parked': 0}
    assert 'token' not in result and 'acceptance' not in result
