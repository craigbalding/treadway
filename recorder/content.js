// Records what the person does on the page while a journey is active, and runs
// "Fill all" when the side panel asks. Loaded after lib/fields.js and lib/page-fill.js.
(function () {
  'use strict';

  const PageFill = globalThis.TreadwayPageFill;
  const Fields = globalThis.TreadwayFields;
  let recording = false;

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  function record(event) {
    if (!recording) return;
    send({ kind: 'page-event', event: Object.assign({ url: location.href, frame: window === window.top ? 'top' : 'child' }, event) });
  }

  function setRecording(active) {
    const started = active && !recording;
    recording = Boolean(active);
    if (started) record({ type: 'page', title: document.title });
  }

  // Only trusted events are the person's own; "Fill all" reports its own values.
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = PageFill.actionTarget(event.target);
    record({ type: 'click', selectors: PageFill.selectorsFor(target), tag: target.localName });
  }, true);

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    const submitter = event.submitter ? PageFill.selectorsFor(event.submitter) : null;
    record({ type: 'submit', selectors: PageFill.selectorsFor(event.target), submitter, trusted: event.isTrusted });
  }, true);

  document.addEventListener('change', (event) => {
    const element = event.target;
    if (!event.isTrusted || !(element instanceof Element) || !/^(input|select|textarea)$/.test(element.localName)) return;
    const field = PageFill.describeField(element);
    const rule = Fields.ruleType(field);
    const fieldType = rule ? rule.type : null;
    const entry = { type: 'field', source: 'human', selectors: PageFill.selectorsFor(element), fieldType };
    if (element.type === 'checkbox' || element.type === 'radio') entry.checked = element.checked;
    // Secrets are recorded only as a reference that the background adds.
    if (element.type === 'password' || Fields.SECRET_TYPES.has(fieldType)) entry.redacted = true;
    else entry.value = element.value;
    record(entry);
  }, true);

  window.addEventListener('popstate', () => record({ type: 'navigation', how: 'popstate' }));
  window.addEventListener('hashchange', () => record({ type: 'navigation', how: 'hashchange' }));

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.kind === 'recording') {
      setRecording(message.active);
      return false;
    }
    if (message.kind === 'fill' && window === window.top) {
      const classify = message.classify
        ? (fields) => chrome.runtime.sendMessage({ kind: 'classify', fields }).then((answer) => {
          if (answer && answer.error) throw new Error(answer.error);
          return (answer && answer.types) || {};
        })
        : null;
      PageFill.fillAll(document, { values: message.values, classify })
        .then((report) => reply({ report, url: location.href }))
        .catch((error) => reply({ error: error.message }));
      return true;
    }
    return false;
  });

  send({ kind: 'recording?' }).then((answer) => setRecording(answer && answer.active));
})();
