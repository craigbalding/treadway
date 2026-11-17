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
import uuid

from .browser_state import _directory, _read, _write


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
    known = {'acquisition_intent', 'context_acquired', 'profile_acquired', 'acquisition_ready', 'acquisition_incomplete',
             'cleanup_intent', 'cleanup_result', 'transport_lost', 'client_lost',
             'command_dispatch', 'command_replied', 'command_unknown', 'application_reconciled'}
    reconnect_events = {'reconnect_prepare_intent', 'reconnect_provider_replied', 'reconnect_prepared',
        'reconnect_prepare_incomplete', 'reconnect_intent', 'reconnect_ready', 'reconnect_incomplete',
        'reconnect_principal_incomplete'}
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
            if kind not in known | reconnect_events or not _identifier(event.get('actor')) or not _identifier(event.get('generation')):
                raise ValueError()
            key = (event['actor'], event['generation'])
            if kind == 'acquisition_intent':
                mode = event.get('mode', 'fresh')
                if key in actors or stopped or mode not in {'fresh', 'borrowed', 'provider-session'}:
                    raise ValueError()
                actors[key] = {'actor': key[0], 'generation': key[1], 'mode': mode, 'allocation': 'unknown',
                               'contextAcquired': False, 'commands': {}, 'cleanup': None, 'reconnections': []}
                continue
            actor = actors[key]
            if kind in reconnect_events:
                fact = {'kind': kind}
                if 'reference' in event:
                    if not _identifier(event['reference']):
                        raise ValueError()
                    fact['reference'] = event['reference']
                if 'evidence' in event:
                    evidence = event['evidence']
                    if (not isinstance(evidence, dict) or not isinstance(evidence.get('reference'), str)
                            or not re.fullmatch(r'reconnect-(?:provider|observation)-[0-9a-f-]{36}\.json', evidence['reference'])
                            or not isinstance(evidence.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', evidence['sha256'])):
                        raise ValueError()
                    try:
                        valid = hashlib.sha256(_read(directory / evidence['reference'], 1024 * 1024)).hexdigest() == evidence['sha256']
                    except (OSError, ValueError, RuntimeError):
                        valid = False
                    fact.update(evidence=evidence, evidenceValid=valid)
                actor['reconnections'].append(fact)
            elif kind == 'context_acquired':
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
                if 'profileReleased' in event and type(event['profileReleased']) is not bool:
                    raise ValueError()
                actor['cleanup'] = {'contextDisposed': event['contextDisposed'], 'connectionClosed': event['connectionClosed'],
                                    'attachmentDetached': event.get('attachmentDetached') is True,
                                    **({'profileReleased': event['profileReleased']} if 'profileReleased' in event else {}),
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
    journal_digest = hashlib.sha256(raw).hexdigest()
    offline, offline_complete = _offline_observations(directory, project_id, run_id, journal_digest, actors)
    for key, actor in actors.items():
        actor['commands'] = list(actor['commands'].values())
        for command in actor['commands']:
            command['offlineReconciliations'] = offline.get((*key, command['requestRef']), [])
        actor['unresolvedEffects'] = [command['requestRef'] for command in actor['commands']
            if command['outcome'] == 'unknown' and not _resolved(command, offline_complete)]
    return {'version': 'treadway.browser-run-observation/1', 'projectId': project_id, 'runId': run_id,
            'journalComplete': complete, 'workerStoppedObserved': stopped, 'issue': issue,
            'journalSha256': journal_digest, 'actors': list(actors.values()),
            'offlineEvidenceComplete': offline_complete,
            'resumePermitted': False}


def retain_reconciliation_evidence(directory, evidence):
    """Copy bounded private application evidence for live or offline receipts."""
    try:
        data = _read(Path(evidence), 16 * 1024 * 1024)
    except (OSError, RuntimeError):
        raise BrowserEvidenceIncomplete('private_bounded_reconciliation_evidence_required') from None
    reference = str(uuid.uuid4())
    destination = _directory(Path(directory) / 'reconciliations') / reference
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    parent = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return {'reference': reference, 'sha256': hashlib.sha256(data).hexdigest()}


def record_browser_reconciliation(directory, *, project_id, run_id, actor, generation,
                                  request_ref, journal_sha256, outcome, evidence):
    """Retain an independent observation, including after the worker has exited.

    The immutable sidecar binds the exact journal bytes and dispatched request.
    A later journal append makes it stale. Neither this observation nor a stopped
    local worker establishes a remote fence or authorizes resuming the generation.
    """
    if outcome not in {'applied', 'not_applied', 'unknown'}:
        raise ValueError('remote_reconciliation_outcome_required')
    observed = inspect_browser_run(directory, project_id=project_id, run_id=run_id)
    if observed['journalSha256'] != journal_sha256:
        raise BrowserEvidenceIncomplete('browser_reconciliation_journal_differs')
    matches = [command for item in observed['actors'] if item['actor'] == actor and item['generation'] == generation
               for command in item['commands'] if command['requestRef'] == request_ref]
    if len(matches) != 1 or matches[0]['outcome'] != 'unknown':
        raise BrowserEvidenceIncomplete('browser_reconciliation_unknown_dispatch_required')
    directory = Path(directory).absolute()
    retained = retain_reconciliation_evidence(directory, evidence)
    decision = {'version': 'treadway.browser-offline-reconciliation/1', 'projectId': project_id,
        'runId': run_id, 'actor': actor, 'generation': generation, 'requestRef': request_ref,
        'journalSha256': journal_sha256, 'outcome': outcome, 'evidence': retained}
    name = str(uuid.uuid4()) + '.json'
    _write(_directory(directory / 'offline-reconciliations') / name, decision)
    return {'recorded': True, 'reference': name, 'evidence': retained, 'resumePermitted': False}


def _offline_observations(directory, project_id, run_id, journal_digest, actors):
    observations = {}
    source = directory / 'offline-reconciliations'
    if not source.exists() and not source.is_symlink():
        return observations, True
    try:
        metadata = source.stat()
        if source.is_symlink() or not source.is_dir() or metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
            raise ValueError()
        files = list(source.iterdir())
        if len(files) > 1024:
            raise ValueError()
        for file in files:
            if not re.fullmatch(r'[0-9a-f-]{36}\.json', file.name):
                # An atomic writer's unpublished temporary file is not a record.
                if file.name.startswith('.'):
                    continue
                raise ValueError()
            item = json.loads(_read(file, 65536))
            if (not isinstance(item, dict) or item.get('version') != 'treadway.browser-offline-reconciliation/1'
                    or item.get('projectId') != project_id or item.get('runId') != run_id
                    or item.get('outcome') not in {'applied', 'not_applied', 'unknown'}):
                raise ValueError()
            if item.get('journalSha256') != journal_digest:
                continue
            key = (item['actor'], item['generation'])
            if item['requestRef'] not in actors[key]['commands']:
                raise ValueError()
            evidence = item['evidence']
            if (not isinstance(evidence, dict) or not _identifier(evidence.get('reference'))
                    or not isinstance(evidence.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', evidence['sha256'])):
                raise ValueError()
            evidence_directory = directory / 'reconciliations'
            if evidence_directory.is_symlink():
                raise ValueError()
            valid = hashlib.sha256(_read(evidence_directory / evidence['reference'], 16 * 1024 * 1024)).hexdigest() == evidence['sha256']
            observations.setdefault((*key, item['requestRef']), []).append({
                'outcome': item['outcome'], 'evidenceValid': valid, 'evidence': evidence, 'reference': file.name})
        return observations, True
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        return observations, False


def _resolved(command, offline_complete):
    observations = ([command['reconciliation']] if command['reconciliation'] else []) + command['offlineReconciliations']
    if not offline_complete or any(item['evidenceValid'] is not True for item in observations):
        return False
    outcomes = {item['outcome'] for item in observations if item['outcome'] != 'unknown'}
    return len(outcomes) == 1
