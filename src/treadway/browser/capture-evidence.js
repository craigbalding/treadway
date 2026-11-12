'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

// Uses the existing CDP transport. Pixels remain in memory until the selected
// document/stage is re-observed; a navigation during capture discards the image.
async function captureEvidence(session, {file, observe, documentId, stage, sensitive = [], mask = 'none', timeoutMs = 2000} = {}) {
  if (!['none', 'credentials'].includes(mask)) throw new Error('explicit_screenshot_mask_policy_required');
  const key = '__treadwayMask_' + crypto.randomUUID().replaceAll('-', '');
  const evaluate = async expression => {
    const r = await session.cdp.send('Runtime.evaluate', {expression, returnByValue: true}, {timeoutMs});
    if (r.exceptionDetails) throw new Error('screenshot_mask_incomplete');
    return r.result?.value;
  };
  const started = Date.now(); let masked = false, result;
  const restore = async () => {
    await evaluate(`(()=>{const s=window[${JSON.stringify(key)}];if(!s)return true;s.style.remove();for(const {e,style} of s.nodes){if(style===null)e.removeAttribute('style');else e.setAttribute('style',style);}delete window[${JSON.stringify(key)}];return true;})()`);
    masked = false;
  };
  try {
    const before = await observe();
    if (before.documentId !== documentId || before.stage !== stage) return result = {status: 'screen_changed', elapsedMs: Date.now() - started};
    if (mask === 'credentials') {
    masked = true;
    const installed = await evaluate(`(()=>{
      if(window.__treadwayEntraDocument!==${JSON.stringify(documentId)})return false;
      const state={nodes:[],style:document.createElement('style')};
      state.style.textContent='input,textarea,[contenteditable]{color:transparent!important;text-shadow:none!important;-webkit-text-security:disc!important}input::placeholder{color:transparent!important}';
      document.documentElement.append(state.style);
      const secrets=${JSON.stringify(sensitive.filter(x => typeof x === 'string' && x))};
      const hide=e=>{if(!e||state.nodes.some(x=>x.e===e))return;state.nodes.push({e,style:e.getAttribute('style')});e.style.setProperty('visibility','hidden','important');};
      if(${JSON.stringify(stage)}.startsWith('registration_')) hide(document.body);
      else{
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
        while((n=walker.nextNode()))if(secrets.some(s=>n.nodeValue.includes(s)))hide(n.parentElement);
        document.querySelectorAll('input[type=password],img[src^="otpauth:"],canvas[data-secret],svg[data-secret]').forEach(hide);
      }
      window[${JSON.stringify(key)}]=state;return true;
    })()`);
    if (!installed) return result = {status: 'screen_changed', elapsedMs: Date.now() - started};
    // Give the masking styles a paint opportunity without waiting for network.
    await session.cdp.send('Runtime.evaluate', {expression: 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))', awaitPromise: true, returnByValue: true}, {timeoutMs});
    }
    const image = await session.cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false}, {timeoutMs});
    // Masking changes visibility and innerText. Restore before the semantic
    // stage check; pixels remain private in memory until that check succeeds.
    if (masked) await restore();
    const after = await observe();
    if (after.documentId !== documentId || after.stage !== stage) return result = {status: 'screen_changed', elapsedMs: Date.now() - started};
    if (typeof image.data !== 'string') throw new Error('screenshot_data_missing');
    const bytes = Buffer.from(image.data, 'base64');
    fs.writeFileSync(file, bytes, {flag: 'wx', mode: 0o600});
    result = {status: 'captured', file, bytes: bytes.length, elapsedMs: Date.now() - started, masked: mask !== 'none',
      maskPolicy: mask === 'none' ? 'none' : stage.startsWith('registration_') ? 'full_enrollment_screen' : 'credential_fields_and_known_secrets'};
    return result;
  } catch {
    return result = {status: 'unavailable', elapsedMs: Date.now() - started};
  } finally {
    if (masked) {
      try {
        await restore();
      } catch { if (result) result.maskCleanup = 'incomplete'; }
    }
  }
}
module.exports = {captureEvidence};
