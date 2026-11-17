"""Read retained worker facts without opening a browser or replaying a command.

A dispatch without an observed reply stays unknown after worker death. These
observations never grant a new lease or certify that remote execution stopped.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re

from .browser_state import _read


class BrowserEvidenceIncomplete(RuntimeError):
    """Code-only evidence failure; never include raw journal or provider text."""


def _identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value)


def inspect_browser_run(directory, *, project_id, run_id):
    """Return a private run's durable prefix, including torn/crashed attempts.

    The expected project and run must come from the caller's retained binding.
    A syntactically complete journal is distinct from a stopped worker. Cleanup
    and independent application reconciliation remain separate observations.
    """
    if not _identifier(project_id) or not _identifier(run_id):
        raise ValueError('explicit_browser_run_binding_required')
    directory = Path(directory).absolute()
    if any(part.is_symlink() for part in (*directory.parents, directory)):
        raise BrowserEvidenceIncomplete('private_browser_run_evidence_required')
    try:
        metadata = directory.stat()
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise BrowserEvidenceIncomplete('private_browser_run_evidence_required')
        raw = _read(directory / 'events.jsonl', 64 * 1024 * 1024)
    except (OSError, RuntimeError):
        raise BrowserEvidenceIncomplete('private_bounded_browser_run_evidence_required') from None
    lines = raw.splitlines(keepends=True)
    try:
        if not lines[0].endswith(b'\n'):
            raise ValueError()
        header = json.loads(lines[0])
    except (IndexError, ValueError):
        raise BrowserEvidenceIncomplete('browser_run_header_incomplete') from None
    if (not isinstance(header, dict) or header.get('kind') != 'worker_started' or header.get('version', 1) != 1
            or header.get('projectId') != project_id or header.get('runId') != run_id):
        raise BrowserEvidenceIncomplete('browser_run_binding_differs')
    actors, complete, stopped = {}, True, False
    issue = None
    known = {'acquisition_intent', 'context_acquired', 'acquisition_ready', 'acquisition_incomplete',
             'cleanup_intent', 'cleanup_result', 'transport_lost', 'client_lost',
             'command_dispatch', 'command_replied', 'command_unknown', 'application_reconciled'}
    for line in lines[1:]:
        if not line.endswith(b'\n'):
            complete, issue = False, 'browser_run_torn_tail'
            break
        try:
            if len(line) > 65536:
                raise ValueError()
            event = json.loads(line)
            kind = event['kind']
            if kind == 'worker_stopped':
                if stopped:
                    raise ValueError()
                stopped = True
                continue
            if kind not in known or not _identifier(event.get('actor')) or not _identifier(event.get('generation')):
                raise ValueError()
            key = (event['actor'], event['generation'])
            if kind == 'acquisition_intent':
                mode = event.get('mode', 'fresh')
                if key in actors or stopped or mode not in {'fresh', 'borrowed'}:
                    raise ValueError()
                actors[key] = {'actor': key[0], 'generation': key[1], 'mode': mode, 'allocation': 'unknown',
                               'contextAcquired': False, 'commands': {}, 'cleanup': None}
                continue
            actor = actors[key]
            if kind == 'context_acquired':
                actor['contextAcquired'] = True
            elif kind == 'acquisition_ready':
                actor['allocation'] = 'ready'
            elif kind == 'acquisition_incomplete':
                actor['allocation'] = 'incomplete'
            elif kind == 'cleanup_result':
                if type(event.get('contextDisposed')) is not bool or type(event.get('connectionClosed')) is not bool:
                    raise ValueError()
                if 'attachmentDetached' in event and type(event['attachmentDetached']) is not bool:
                    raise ValueError()
                actor['cleanup'] = {'contextDisposed': event['contextDisposed'], 'connectionClosed': event['connectionClosed'],
                                    'attachmentDetached': event.get('attachmentDetached') is True,
                                    'remoteTermination': event.get('remoteTermination') == 'confirmed'}
            elif kind in {'command_dispatch', 'command_replied', 'command_unknown', 'application_reconciled'}:
                reference = event['requestRef']
                if not isinstance(reference, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}:[1-9][0-9]{0,15}', reference):
                    raise ValueError()
                commands = actor['commands']
                if kind == 'command_dispatch':
                    if reference in commands or not isinstance(event.get('method'), str) or not re.fullmatch(
                            r'[A-Za-z]{1,50}\.[A-Za-z]{1,70}', event['method']):
                        raise ValueError()
                    commands[reference] = {'requestRef': reference, 'method': event['method'],
                                           'outcome': 'unknown', 'replyObserved': False, 'reconciliation': None}
                else:
                    command = commands[reference]
                    if kind == 'command_replied':
                        command.update(outcome='replied', replyObserved=True)
                    elif kind == 'command_unknown':
                        command.update(outcome='unknown', replyObserved=False)
                    else:
                        evidence = event['evidence']
                        if (not isinstance(evidence, dict) or event['outcome'] not in {'applied', 'not_applied', 'unknown'} or command['replyObserved']
                                or not _identifier(evidence.get('reference')) or not isinstance(evidence.get('sha256'), str)
                                or not re.fullmatch(r'[a-f0-9]{64}', evidence['sha256'])):
                            raise ValueError()
                        try:
                            source = directory / 'reconciliations' / evidence['reference']
                            if source.parent.is_symlink():
                                raise ValueError()
                            valid = hashlib.sha256(_read(source, 16 * 1024 * 1024)).hexdigest() == evidence['sha256']
                        except (OSError, ValueError, RuntimeError):
                            valid = False
                        command['reconciliation'] = {'outcome': event['outcome'], 'evidenceValid': valid,
                            'evidence': {'reference': evidence['reference'], 'sha256': evidence['sha256']}}
        except (ValueError, TypeError, KeyError):
            complete, issue = False, 'browser_run_record_incomplete'
            break
    for actor in actors.values():
        actor['commands'] = list(actor['commands'].values())
        actor['unresolvedEffects'] = [command['requestRef'] for command in actor['commands']
            if command['outcome'] == 'unknown' and not (command['reconciliation']
                and command['reconciliation']['evidenceValid'] and command['reconciliation']['outcome'] != 'unknown')]
    return {'version': 'treadway.browser-run-observation/1', 'projectId': project_id, 'runId': run_id,
            'journalComplete': complete, 'workerStoppedObserved': stopped, 'issue': issue,
            'journalSha256': hashlib.sha256(raw).hexdigest(), 'actors': list(actors.values()),
            'resumePermitted': False}
