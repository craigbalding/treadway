'use strict';
// Call only after establishing exclusive ownership of the entire browser.
async function closeOwnedBrowser(actor, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let timer, onClose;
  const disconnected = new Promise(resolve => {
    onClose = () => resolve(true);
    if (actor.ws.readyState === actor.ws.CLOSED) resolve(true);
    else actor.ws.once('close', onClose);
    timer = setTimeout(() => resolve(false), Math.max(1, deadline - performance.now()));
  });
  try {
    await actor.cdp.send('Browser.close', {}, {timeoutMs: Math.max(1, Math.ceil(deadline - performance.now()))});
    return await disconnected;
  } catch { return false; }
  finally { clearTimeout(timer); actor.ws.removeListener('close', onClose); }
}
module.exports = {closeOwnedBrowser};
