'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stream = require('../lib/journal-stream.js');
const { createHarness } = require('./helpers/background-harness.js');
const record = (run, count = 4) => ({ contextFields: { run }, persona: { id: 'sample', secrets: {} },
  startedAt: '2026-11-24T10:00:00Z', revision: count,
  events: Array.from({ length: count }, (_, i) => ({ type: 'marker', eventId: run + ':e' + (i + 1), name: 'Step ' + i })) });

test('bounded journal pages advance only delivered events and retain per-run cursors', () => {
  const state = { journey: record('run-b'), journalArchive: [{ record: record('run-a'), outcome: 'saved' }] };
  const first = Stream.read(state, { limit: 2 });
  assert.deepEqual(first.events.map(e => e.eventId), ['run-a:e1', 'run-a:e2']);
  assert.deepEqual(first.nextCursors, { 'run-a': 2 });
  const next = Stream.read(state, { cursors: first.nextCursors, limit: 3 });
  assert.deepEqual(next.events.map(e => e.eventId), ['run-a:e3', 'run-a:e4', 'run-b:e1']);
  assert.deepEqual(next.nextCursors, { 'run-a': 4, 'run-b': 1 });
  assert.equal(Stream.read(state, { cursors: { 'run-a': 4, 'run-b': 4 } }).events.length, 0);
});

test('retention reports explicit gaps without treating a consumed eviction as evidence loss', () => {
  let archive = [], evictions = [];
  for (let i = 0; i < 6; i++) { const next = Stream.retain(archive, record('run-' + i), 'saved'); archive = next.archive; evictions.push(...next.evicted); }
  assert.equal(archive.length, 4);
  const pending = Stream.read({ journalArchive: archive, journalEvictions: evictions }, { cursors: { 'run-0': 2 } });
  assert.deepEqual(pending.gaps[0], { run: 'run-0', afterRevision: 2, throughRevision: 4, reason: 'run_not_retained' });
  const consumed = Stream.read({ journalArchive: archive, journalEvictions: evictions }, { cursors: { 'run-0': 4 } });
  assert(!consumed.gaps.some(gap => gap.run === 'run-0'));
  const tail = record('tail'); tail.events.splice(0, 2);
  const page = Stream.read({ journey: tail });
  assert.equal(page.gaps[0].throughRevision, 2);
  assert.deepEqual(page.events.map(e => e.revision), [3, 4]);
});

test('saved and late stopped-run events stay readable; API keys and stream health do not enter evidence', async () => {
  const h = createHarness({ settings: { jevKey: 'model-api-key', recordSecrets: false } });
  await h.start();
  const run = h.session.journey.contextFields.run;
  await h.command({ kind: 'page-event', event: { type: 'field', fieldType: 'password', value: 'TestSecret!7', secret: true } });
  await h.command({ kind: 'page-event', event: { type: 'field', value: 'model-api-key fixture-key' } });
  const from = { url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html' };
  const page = await h.command({ kind: 'journal-read', limit: 1 }, from);
  assert.equal(page.events.length, 1);
  assert.equal(h.session.liveStream.state, 'connected');
  assert(!h.session.journey.events.some(e => e.type.includes('stream')));
  await h.emit('webRequest', 'onBeforeRequest', { requestId: 'delayed', tabId: 7, url: 'https://app.example.test/late', method: 'GET', timeStamp: Date.now() });
  await h.command({ kind: 'stop' });
  await h.emit('webRequest', 'onCompleted', { requestId: 'delayed', tabId: 7, url: 'https://app.example.test/late', method: 'GET', statusCode: 200, timeStamp: Date.now() });
  await h.command({ kind: 'saved', run, revision: h.session.finished.revision });
  assert.equal(h.session.finished, null);
  const final = await h.command({ kind: 'journal-read' }, from);
  assert(final.events.some(e => e.event.type === 'network_completed'));
  assert.equal(final.streams[0].state, 'saved');
  const text = JSON.stringify(final);
  for (const secret of ['fixture-key', 'model-api-key', 'TestSecret!7']) assert(!text.includes(secret));
  assert((await h.command({ kind: 'journal-read' })).error.includes('require'));
});

test('JSONL output resumes without duplicates, binds source and uses private permissions', async t => {
  const { openJournalOutput } = await import('../stream.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-stream-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.jsonl');
  let output = await openJournalOutput(file);
  output.bind({ generation: 'sample-generation', extensionId: 'a'.repeat(32) });
  const page = Stream.read({ journey: record('run-a') });
  output.append(page); output.close();
  const original = fs.readFileSync(file, 'utf8');
  output = await openJournalOutput(file);
  output.bind({ generation: 'sample-generation', extensionId: 'a'.repeat(32) });
  assert.equal(output.cursors['run-a'], 4);
  assert.equal(output.append(page), 0);
  assert.throws(() => output.bind({ generation: 'different', extensionId: 'a'.repeat(32) }), /different/);
  output.close();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('failed output writes do not advance the caller cursor; incomplete files and symlinks are retained', async t => {
  const { openJournalOutput } = await import('../stream.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-stream-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.jsonl'); const output = await openJournalOutput(file);
  const write = fs.writeSync; fs.writeSync = () => { throw new Error('fixture disk failure'); };
  try { assert.throws(() => output.append(Stream.read({ journey: record('run-a') })), /disk failure/); }
  finally { fs.writeSync = write; }
  assert.deepEqual(output.cursors, {}); output.close();
  fs.writeFileSync(file, '{"incomplete":');
  await assert.rejects(openJournalOutput(file), /incomplete/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"incomplete":');
  const link = path.join(directory, 'link.jsonl'); fs.symlinkSync(file, link);
  await assert.rejects(openJournalOutput(link));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"incomplete":');
});
