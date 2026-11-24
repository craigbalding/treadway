// An observational CDP connection bound to one managed browser generation.
import fs from 'node:fs';
function ownerOf(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid owned session file');
  const owner = JSON.parse(fs.readFileSync(file, 'utf8')).session;
  if (!owner?.generation || !Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 ||
    !owner.browser_path?.startsWith('/devtools/browser/')) throw new Error('Incomplete owned browser session');
  return owner;
}
export async function connectOwnedWorker(file, extensionId) {
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid recorder extension ID');
  const owner = ownerOf(file);
  const ws = new WebSocket('ws://127.0.0.1:' + owner.port + owner.browser_path);
  let sequence = 0; const pending = new Map(); let attached;
  const check = () => {
    const current = ownerOf(file);
    if (current.generation !== owner.generation || current.port !== owner.port || current.browser_path !== owner.browser_path) throw new Error('Owned browser generation changed');
  };
  ws.addEventListener('message', ({ data }) => {
    const item = JSON.parse(String(data)); const next = pending.get(item.id);
    if (next) { pending.delete(item.id); item.error ? next.reject(new Error(item.error.message)) : next.resolve(item.result); }
  });
  ws.addEventListener('close', () => { for (const next of pending.values()) next.reject(new Error('Owned browser connection closed')); pending.clear(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned browser connection timed out')), 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Owned browser connection failed')); }, { once: true });
  });
  function call(method, params = {}, sessionId) {
    check();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Read-only CDP call timed out: ' + method)); }, 10000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  try {
    const { targetInfos } = await call('Target.getTargets');
    const candidates = targetInfos.filter(item => item.type === 'service_worker' &&
      /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(item.url) && (!extensionId || new URL(item.url).host === extensionId));
    const matching = [];
    for (const target of candidates) {
      const result = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sessionId = result.sessionId;
      const manifest = await call('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId);
      if (manifest.result?.value === 'Treadway Flow Recorder') matching.push({ target, sessionId });
      else await call('Target.detachFromTarget', { sessionId });
    }
    if (matching.length !== 1) {
      for (const item of matching) await call('Target.detachFromTarget', { sessionId: item.sessionId });
      throw new Error('One running Treadway worker is required; open its panel and supply the exact extension ID');
    }
    attached = matching[0].sessionId;
    await call('Runtime.enable', {}, attached);
    return {
      generation: owner.generation, extensionId: new URL(matching[0].target.url).host,
      async evaluate(expression) {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result?.value;
      },
      async close() {
        try { await call('Target.detachFromTarget', { sessionId: attached }); }
        catch (_) { /* The owner or connection may already have ended. */ }
        finally { ws.close(); }
      },
    };
  } catch (error) { ws.close(); throw error; }
}
