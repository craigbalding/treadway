'use strict';
// Private stdin transport for the native Robot keyword. Credentials are never
// arguments, environment variables set by this helper, or stdout fields.
const fs = require('node:fs');
const path = require('node:path');
const {connect, createCdpProxy} = require('./cdp.js');
const {EntraLogin, totp} = require('./entra.js');
const {EntraStop} = require('./entra-flow.js');
const {execFile} = require('node:child_process');

function resolvePrivateCredentials(source) {
  return new Promise((resolve, reject) => {
    const child = execFile(source.python, ['-m', 'treadway.entra_robot', '--resolve-credentials'],
      {timeout: 10000, maxBuffer: 262144}, (error, stdout) => {
        if (error) return reject(new Error('credential_resolution_incomplete'));
        try {resolve(JSON.parse(stdout));} catch {reject(new Error('credential_resolution_incomplete'));}
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({refs: source.refs, identity: source.identity}));
  });
}

function seedStore(root) {
  const pending = path.join(root, 'pending.json'), confirmed = path.join(root, 'confirmed.json');
  function read(file) {
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('private_totp_store_required');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  function privateRoot() {
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('private_totp_store_required');
    fs.chmodSync(root, 0o700);
  }
  function durableWrite(file, value) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);}
    finally {fs.closeSync(fd);}
    const directory = fs.openSync(root, 'r');
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
  }
  return {
    read: () => read(confirmed), candidate: () => read(pending),
    seedFor(username, supplied) {
      const saved = read(confirmed), candidate = read(pending);
      if ([saved, candidate].some(value => value && value.username !== username)) throw new Error('totp_store_identity_differs');
      if (saved && supplied && saved.secret !== supplied) throw new Error('totp_credential_conflict');
      if (candidate) throw new Error('totp_enrollment_pending');
      return supplied || saved?.secret || null;
    },
    async stage(value) {
      privateRoot();
      if (read(confirmed)) throw new Error('totp_store_already_confirmed');
      const previous = read(pending);
      if (previous) {
        if (previous.username !== value.username || previous.secret !== value.secret) throw new Error('totp_enrollment_pending');
      } else durableWrite(pending, value);
      return pending;
    },
    async confirm(reference) {
      if (reference !== pending) throw new Error('totp_candidate_binding_differs');
      const value = read(pending); if (!value) throw new Error('totp_candidate_missing');
      const previous = read(confirmed);
      if (previous && (previous.username !== value.username || previous.secret !== value.secret)) throw new Error('totp_credential_conflict');
      if (!previous) durableWrite(confirmed, value);
      fs.unlinkSync(pending);
    },
  };
}

async function main() {
  let session, phase = 'input';
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    phase = 'connect';
    session = await connect(createCdpProxy(input.connection), input.connection.targetId, {commandTimeoutMs: 5000});
    phase = 'credential_store';
    const store = seedStore(input.totpRoot);
    let credentials;
    const resolve = async () => {
      let supplied = input.credentials;
      if (!supplied && input.credentialSource) {
        const source = input.credentialSource;
        try {
          supplied = await resolvePrivateCredentials(source);
        } catch {throw new EntraStop('credential_resolution_incomplete');}
      }
      if (!supplied || typeof supplied.username !== 'string') throw new EntraStop('credentials_unavailable');
      let seed;
      try {seed = store.seedFor(supplied.username, supplied.totpSecret);}
      catch (error) {
        if (['private_totp_store_required', 'totp_store_identity_differs', 'totp_credential_conflict', 'totp_enrollment_pending'].includes(error.message))
          throw new EntraStop(error.message);
        throw error;
      }
      credentials = {...supplied, ...(seed ? {totpSecret: seed} : {})};
      return credentials;
    };
    phase = 'flow_configuration';
    const flow = new EntraLogin(session, {...input.options, credentials: resolve,
      beforeSubmit: async () => input.allowSubmission === true,
      codeProvider: () => {const seed = store.seedFor(credentials.username, credentials.totpSecret); return seed ? totp(seed) : null;},
      totpStore: store});
    phase = 'flow'; const receipt = await flow.run();
    process.stdout.write(JSON.stringify(receipt));
    return receipt.status === 'verified' ? 0 : 1;
  } catch (e) {
    const known = ['private_totp_store_required','totp_store_already_confirmed','totp_enrollment_pending',
      'totp_candidate_binding_differs','totp_candidate_missing','totp_store_identity_differs','totp_credential_conflict'];
    process.stdout.write(JSON.stringify({status: known.includes(e.message) ? e.message : 'entra_runner_unavailable', phase, outcome: 'unknown', errorType: e.name}));
    return 1;
  } finally {session?.close();}
}

if (require.main === module) main().then(code => {process.exitCode = code;});
module.exports = {seedStore};
