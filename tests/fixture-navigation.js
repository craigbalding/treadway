'use strict';
const path = require('node:path');
const browserRoot = process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname, '../src/treadway/browser');
const {BrowserInteractions, waitForObservation} = require(path.join(browserRoot, 'interactions.js'));
const {waitForReady} = require(path.join(browserRoot, 'cdp.js'));

// Reuse the shared loader-bound navigation and usable-control checks, with one
// existing fixture-readiness budget across dispatch, document commit and controls.
// Same-URL resets must observe the acknowledged new loader, never old controls.
async function navigateFixture(session, url, {selectors = [], predicate = null, timeoutMs, record = () => {}} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 100 || (!selectors.length && !predicate))
    throw new Error('explicit_fixture_readiness_and_deadline_required');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('fixture_navigation_readiness_deadline');
    return value;
  };
  const cdp = new Proxy(session.cdp, {get(target, key) {
    if (key === 'send') return (method, parameters, options = {}) => target.send(method, parameters,
      {...options, timeoutMs: Math.min(options.timeoutMs || Infinity, remaining())});
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const ui = new BrowserInteractions({...session, cdp}, {origin: new URL(url).origin, record});
  ui.wait = (description, observe, windowMs) => waitForObservation(description, observe,
    {windowMs: Math.min(windowMs, remaining()), intervalMs: 50, record});
  try {
    await ui.navigate(url);
    const condition = `location.href===${JSON.stringify(new URL(url).href)}` + (predicate ? ` && (${predicate})` : '');
    return await waitForReady(cdp, {selectors, predicate: condition, timeoutMs: Math.max(1, remaining() - 100)});
  } finally {ui.dispose();}
}

module.exports = {navigateFixture};
