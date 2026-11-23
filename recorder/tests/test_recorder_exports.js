'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { save } = require('../lib/download-export.js');

function fixture(state = 'in_progress') {
  const listeners = new Set();
  const calls = [];
  const revoked = [];
  let item = { id: 7, state, filename: '/synthetic-downloads/Treadway/journeys/run-test.json' };
  const downloads = {
    download: async (options) => { calls.push(options); return 7; },
    search: async () => [item],
    onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
  };
  const options = { downloads, urls: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: (url) => revoked.push(url) } };
  return { options, calls, revoked, listeners,
    terminal(state, error) { item = { ...item, state, error }; for (const listener of listeners) listener({ id: 7, state: { current: state } }); } };
}

test('export waits for completed write and never asks for a native chooser', async () => {
  const f = fixture();
  let finished = false;
  const operation = save('{"synthetic":true}', 'run-test', f.options).then((value) => { finished = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(f.calls[0], { url: 'blob:synthetic', filename: 'Treadway/journeys/run-test.json', saveAs: false, conflictAction: 'overwrite' });
  f.terminal('complete');
  assert.equal((await operation).filename, '/synthetic-downloads/Treadway/journeys/run-test.json');
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.revoked, ['blob:synthetic']);
});

test('completion before listener registration remains observable', async () => {
  const f = fixture('complete');
  assert.equal((await save('{}', 'run-test', f.options)).id, 7);
  assert.equal(f.listeners.size, 0);
});

test('interrupted or uncertain exports fail without retrying or acknowledging success', async () => {
  const f = fixture();
  const operation = save('{}', 'run-test', f.options);
  await new Promise((resolve) => setImmediate(resolve));
  f.terminal('interrupted', 'FILE_ACCESS_DENIED');
  await assert.rejects(operation, /FILE_ACCESS_DENIED/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.listeners.size, 0);
  const pending = fixture();
  await assert.rejects(save('{}', 'run-test', { ...pending.options, timeoutMs: 10 }), /unconfirmed/);
  assert.equal(pending.calls.length, 1);
  assert.equal(pending.listeners.size, 0);
});

test('export rejects paths outside its recording filename', async () => {
  const f = fixture();
  await assert.rejects(save('{}', '../outside', f.options), /filename/);
  assert.equal(f.calls.length, 0);
});
