#!/usr/bin/env node
// Continuous observational export for an owned recorder; no application calls.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectOwnedWorker } from './lib/owned-worker.mjs';

export async function openJournalOutput(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30) throw new Error('Invalid stream lock');
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid stream lock PID');
    try { process.kill(pid, 0); throw new Error('Another journal stream owns this output'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    fs.unlinkSync(lock); fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    const cursors = {}; const seen = new Set(); const states = new Map(); const gaps = new Set(); let source = null;
    const durable = lines => {
      const buffer = Buffer.from(lines.map(item => JSON.stringify(item)).join('\n') + '\n');
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
      fs.fsyncSync(fd);
    };
    const size = fs.fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) throw new Error('Journal output has an incomplete final line; preserve and repair it before resuming');
      const input = fs.createReadStream(file, { fd, autoClose: false, start: 0, end: size - 1 });
      for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
        if (!line) continue;
        const item = JSON.parse(line);
        if (item.schema === 'treadway.journal-event/1') { seen.add(item.eventId); cursors[item.run] = Math.max(cursors[item.run] || 0, item.revision); }
        else if (item.schema === 'treadway.journal-state/1') states.set(item.stream.run, JSON.stringify(item.stream));
        else if (item.schema === 'treadway.journal-gap/1') {
          gaps.add(JSON.stringify(item.gap));
          if (item.gap.reason === 'events_not_retained') cursors[item.gap.run] = Math.max(cursors[item.gap.run] || 0, item.gap.throughRevision);
        } else if (item.schema === 'treadway.journal-source/1') {
          if (source && JSON.stringify(source) !== JSON.stringify(item.source)) throw new Error('Journal has mixed browser sources');
          source = item.source;
        } else throw new Error('Output contains a different journal format');
      }
    }
    return {
      cursors,
      bind(binding) {
        if (source && (source.generation !== binding.generation || source.extensionId !== binding.extensionId)) throw new Error('Output belongs to a different browser generation or extension');
        if (!source) { durable([{ schema: 'treadway.journal-source/1', source: binding }]); source = binding; }
      },
      append(page) {
        if (page?.schema !== 'treadway.journal-page/1' || !Array.isArray(page.events) || !Array.isArray(page.streams) || !Array.isArray(page.gaps)) throw new Error('Recorder returned an invalid journal page');
        const lines = []; const nextCursors = { ...cursors }; const newSeen = new Set(); const newGaps = new Set(); const nextStates = new Map();
        for (const gap of page.gaps) {
          const key = JSON.stringify(gap);
          if (!gaps.has(key) && !newGaps.has(key)) { lines.push({ schema: 'treadway.journal-gap/1', gap }); newGaps.add(key); }
          if (gap.reason === 'events_not_retained') nextCursors[gap.run] = Math.max(nextCursors[gap.run] || 0, gap.throughRevision);
        }
        for (const item of page.events) {
          if (!Number.isSafeInteger(item.revision) || item.revision < 1 || item.eventId !== item.run + ':e' + item.revision || item.event?.eventId !== item.eventId) throw new Error('Recorder returned an invalid event identity');
          if (!seen.has(item.eventId) && !newSeen.has(item.eventId)) { lines.push(item); newSeen.add(item.eventId); }
          nextCursors[item.run] = Math.max(nextCursors[item.run] || 0, item.revision);
        }
        for (const stream of page.streams) {
          if ((nextCursors[stream.run] || 0) < stream.revision) continue;
          const key = JSON.stringify(stream);
          if (states.get(stream.run) !== key) { lines.push({ schema: 'treadway.journal-state/1', stream }); nextStates.set(stream.run, key); }
        }
        if (lines.length) durable(lines);
        // Commit the caller's cursor only after every line is durable.
        Object.assign(cursors, nextCursors);
        for (const key of newSeen) seen.add(key);
        for (const key of newGaps) gaps.add(key);
        for (const [run, key] of nextStates) states.set(run, key);
        // The provider retains at most four stopped runs; old file history is
        // authoritative, while request cursors stay bounded for future pages.
        for (const run of Object.keys(cursors).slice(0, -100)) delete cursors[run];
        return lines.length;
      },
      close() { fs.closeSync(fd); fd = undefined; fs.unlinkSync(lock); },
    };
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); fs.unlinkSync(lock); throw error; }
}

export async function streamJournal(sessionFile, output, { extensionId, interval = 1000, duration = 28800, limit = 200, signal } = {}) {
  if (!Number.isFinite(interval) || interval < 100 || !Number.isFinite(duration) || duration <= 0 || duration > 28800) throw new Error('Invalid stream timing');
  const writer = await openJournalOutput(output); let worker; let written = 0;
  const statusFile = output + '.status.json';
  const status = value => {
    const temp = statusFile + '.' + process.pid;
    fs.writeFileSync(temp, JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); fs.renameSync(temp, statusFile);
  };
  try {
    worker = await connectOwnedWorker(sessionFile, extensionId);
    writer.bind({ generation: worker.generation, extensionId: worker.extensionId });
    const deadline = Date.now() + duration * 1000;
    do {
      const options = { cursors: writer.cursors, limit, output: path.basename(output) };
      const page = await worker.evaluate('globalThis.treadwayReadJournal(' + JSON.stringify(options) + ')');
      written += writer.append(page);
      status({ state: 'connected', generation: worker.generation, extensionId: worker.extensionId, cursors: writer.cursors });
      if (page.events.length < limit) await new Promise(resolve => {
        const finish = () => { signal?.removeEventListener('abort', finish); clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, interval);
        signal?.addEventListener('abort', finish, { once: true });
      });
    } while (!signal?.aborted && Date.now() < deadline);
    status({ state: 'stopped', cursors: writer.cursors });
    return { output, written, cursors: writer.cursors };
  } catch (error) {
    try { status({ state: 'error', error: error.message, cursors: writer.cursors }); }
    catch (_) { /* A full/unwritable destination must not hide the root error. */ }
    await worker?.evaluate('globalThis.treadwayJournalStreamError(' + JSON.stringify(error.message) + ')').catch(() => undefined);
    throw error;
  } finally { try { await worker?.close(); } finally { writer.close(); } }
}
if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) {
  const [session, output, extensionId, seconds] = process.argv.slice(2);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  try {
    if (!session || !output) throw new Error('Usage: node recorder/stream.mjs SESSION_JSON OUTPUT_JSONL [EXTENSION_ID] [SECONDS]');
    console.log(JSON.stringify(await streamJournal(session, output, { extensionId, duration: Number(seconds || 28800), signal: controller.signal })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
