'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Append-only, private evidence for one execution. No shared "latest.json";
// a failed attempt and its successful retry always have distinct locations.
class AttemptEvidence {
  constructor({root = path.join(os.homedir(), '.local/state/treadway/attempts'), kind = 'flow'} = {}) {
    this.root = root; this.kind = kind; this.fd = null;
  }
  start() {
    if (this.fd !== null) throw new Error('attempt_already_started');
    fs.mkdirSync(this.root, {recursive: true, mode: 0o700});
    if (!fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) throw new Error('private_evidence_directory_required');
    fs.chmodSync(this.root, 0o700);
    this.id = crypto.randomUUID();
    this.directory = path.join(this.root, this.id);
    fs.mkdirSync(this.directory, {mode: 0o700});
    this.fd = fs.openSync(path.join(this.directory, 'events.jsonl'), 'wx', 0o600);
    this.record({kind: 'attempt_started', flow: this.kind});
    return {id: this.id, directory: this.directory};
  }
  record(event) {
    if (this.fd === null) throw new Error('attempt_not_started');
    fs.writeSync(this.fd, JSON.stringify({at: new Date().toISOString(), ...event}) + '\n');
    fs.fsyncSync(this.fd);
  }
  finish(receipt) {
    this.record({kind: 'attempt_finished', receipt});
    fs.writeFileSync(path.join(this.directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    this.close();
  }
  close() { if (this.fd !== null) {fs.closeSync(this.fd); this.fd = null;} }
}

module.exports = {AttemptEvidence};
