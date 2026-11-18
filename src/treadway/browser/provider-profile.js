'use strict';
// A default profile is permitted only with a private, bound Session API receipt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function fail() { throw Object.assign(new Error('remote_provider_profile_evidence_required'), {code: 'remote_provider_profile_evidence_required'}); }
function read(file, digest, limit) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) fail();
  for (let current = file; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail();
    if (path.dirname(current) === current) break;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.mode & 0o077 || metadata.uid !== process.getuid() || metadata.nlink !== 1 || metadata.size > limit) fail();
    const raw = fs.readFileSync(fd);
    if (crypto.createHash('sha256').update(raw).digest('hex') !== digest) fail();
    return JSON.parse(raw);
  } finally { fs.closeSync(fd); }
}
function authorize(proof, endpoint, projectId) {
  try {
    const capability = read(proof?.file, proof?.sha256, 262144);
    if (capability.version !== 'treadway.browserless-session/1' || capability.binding?.projectId !== projectId ||
        capability.scope !== 'isolated-provider-profile' || capability.state !== 'created' ||
        capability.session?.connect !== endpoint || typeof capability.session.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(capability.session.id) ||
        !/^provider-http-[0-9a-f-]{36}\.json$/.test(capability.creation?.file)) fail();
    const receipt = read(path.join(path.dirname(proof.file), capability.creation.file), capability.creation.sha256, 524288);
    if (receipt.version !== 'treadway.browserless-http/1' || receipt.method !== 'POST' || receipt.complete !== true ||
        !Number.isInteger(receipt.status) || receipt.status < 200 || receipt.status >= 300 || receipt.outcome !== 'replied' ||
        receipt.requestBody?.processKeepAlive !== 0 || receipt.requestBody?.browser !== 'chromium') fail();
    const response = JSON.parse(Buffer.from(receipt.responseBodyBase64, 'base64').toString('utf8'));
    for (const key of ['id', 'connect', 'stop', 'ttl']) if (response[key] !== capability.session[key]) fail();
    if (!Number.isInteger(response.ttl) || response.ttl <= 0 || response.ttl !== receipt.requestBody.ttl) fail();
    const resourceRef = crypto.createHash('sha256').update(capability.session.id).digest('hex');
    return {resourceRef};
  } catch { fail(); }
}
const {closeOwnedBrowser: close} = require('./owned-browser');
module.exports = {authorize, close};
