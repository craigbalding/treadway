// Read-only, caller-cursor journal pages. Stream health never becomes evidence.
(function (root) {
  'use strict';
  const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024;
  const MAX_ARCHIVE_RUNS = 4;
  const archiveSize = value => JSON.stringify(value).length * 3; // Conservative UTF-8 upper bound, including non-ASCII data.
  function eventRevision(event) {
    const match = /:e([1-9][0-9]*)$/.exec(event?.eventId || '');
    if (!match) throw new Error('Journal event has no revision');
    return Number(match[1]);
  }
  function retain(archive, record, outcome) {
    const run = record.contextFields.run;
    const next = (archive || []).filter(item => item.record.contextFields.run !== run);
    next.push({ record, outcome });
    const evicted = [];
    while (next.length > MAX_ARCHIVE_RUNS || (next.length > 1 && archiveSize(next) > MAX_ARCHIVE_BYTES)) {
      const old = next.shift(); evicted.push({ run: old.record.contextFields.run, revision: old.record.revision, reason: 'archive_retention_limit' });
    }
    const last = next[0];
    while (last?.record.events.length > 1 && archiveSize(next) > MAX_ARCHIVE_BYTES) {
      last.record.events.splice(0, Math.ceil(last.record.events.length / 2));
    }
    if (next.length && archiveSize(next) > MAX_ARCHIVE_BYTES) {
      const old = next.pop(); evicted.push({ run: old.record.contextFields.run, revision: old.record.revision, reason: 'archive_record_too_large' });
    }
    return { archive: next, evicted };
  }
  function scrub(value, forbidden) {
    if (typeof value === 'string') {
      for (const secret of forbidden.filter(item => typeof item === 'string' && item.length)) value = value.split(secret).join('[API credential redacted]');
      return value;
    }
    if (Array.isArray(value)) return value.map(item => scrub(item, forbidden));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, forbidden)]));
    return value;
  }
  function read(state, { cursors = {}, limit = 200 } = {}, forbidden = []) {
    if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors) || Object.keys(cursors).length > 100 ||
      Object.values(cursors).some(value => !Number.isSafeInteger(value) || value < 0) ||
      !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid journal stream cursor/limit');
    const records = new Map();
    for (const item of state.journalArchive || []) records.set(item.record.contextFields.run, item);
    for (const [record, outcome] of [[state.finished, 'stopped'], [state.journey, 'active']]) {
      if (record) records.set(record.contextFields.run, { record, outcome });
    }
    const result = { schema: 'treadway.journal-page/1', streams: [], events: [], gaps: [], nextCursors: { ...cursors } };
    for (const [run, after] of Object.entries(cursors)) if (!records.has(run)) {
      const eviction = (state.journalEvictions || []).find(item => item.run === run);
      if (!eviction || after < eviction.revision) result.gaps.push({ run, afterRevision: after,
        ...(eviction ? { throughRevision: eviction.revision } : {}), reason: 'run_not_retained' });
    }
    for (const item of state.journalEvictions || []) if (!records.has(item.run) && cursors[item.run] === undefined) {
      result.gaps.push({ run: item.run, afterRevision: 0, throughRevision: item.revision, reason: 'run_not_retained' });
    }
    const ordered = [...records].sort(([, a], [, b]) => a.record.startedAt.localeCompare(b.record.startedAt));
    for (const [run, { record, outcome }] of ordered) {
      const from = record.events.length ? eventRevision(record.events[0]) : record.revision + 1;
      result.streams.push({ run, state: outcome, revision: record.revision, retainedFromRevision: from,
        startedAt: record.startedAt, stoppedAt: record.stoppedAt || null,
        persona: record.persona, networkCapture: record.networkCapture || null });
      let after = cursors[run] || 0;
      if (after < from - 1) {
        result.gaps.push({ run, afterRevision: after, throughRevision: from - 1, reason: 'events_not_retained' });
        after = from - 1; result.nextCursors[run] = after;
      }
      for (const event of record.events) {
        const revision = eventRevision(event);
        if (revision <= after) continue;
        if (result.events.length >= limit) break;
        result.events.push({ schema: 'treadway.journal-event/1', run, revision, eventId: event.eventId, event });
        result.nextCursors[run] = revision;
      }
    }
    return scrub(result, forbidden);
  }
  const api = { read, retain, eventRevision, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_RUNS };
  root.TreadwayJournalStream = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
