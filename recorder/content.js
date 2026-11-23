// Page observations, including a drainable journal and interruptible Fill all.
(function () {
  'use strict';
  const PageFill = globalThis.TreadwayPageFill;
  const Fields = globalThis.TreadwayFields;
  let recording = false;
  let recordSecrets = false;
  let activeFill = null;
  let fillController = null;
  const pending = new Set();
  const failures = [];
  // randomUUID is restricted to secure contexts; recording also supports HTTP
  // fixtures and applications. getRandomValues is available in both contexts.
  const documentInstanceId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  let sequence = 0;
  async function send(message) {
    const answer = await chrome.runtime.sendMessage(message);
    if (answer && answer.error) throw new Error(answer.error);
    return answer;
  }
  function record(event, force) {
    if (!recording && !force) return Promise.resolve();
    const operation = send({ kind: 'page-event', event: Object.assign({
      at: new Date().toISOString(), clientEventId: documentInstanceId + ':' + (++sequence),
      documentInstanceId, url: location.href, frame: window === window.top ? 'top' : 'child',
    }, event) }).catch((error) => { failures.push(error.message); });
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
    return operation;
  }
  function setRecording(active, secrets) {
    const started = active && !recording;
    recording = Boolean(active);
    recordSecrets = Boolean(secrets);
    if (!recording && fillController) fillController.abort();
    if (started) record({ type: 'page', title: document.title });
  }
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = PageFill.actionTarget(event.target);
    record({ type: 'click', selectors: PageFill.selectorsFor(target), tag: target.localName });
  }, true);
  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    record({ type: 'submit', selectors: PageFill.selectorsFor(event.target),
      submitter: event.submitter ? PageFill.selectorsFor(event.submitter) : null, trusted: event.isTrusted });
  }, true);
  function fieldChanged(event) {
    const element = event.target;
    if (!event.isTrusted || !(element instanceof Element) || !/^(input|select|textarea)$/.test(element.localName)) return;
    const field = PageFill.describeField(element);
    const rule = Fields.ruleType(field);
    const fieldType = PageFill.classifiedTypeFor(element) || (rule ? rule.type : null);
    const entry = { type: 'field', source: 'human', phase: event.type,
      selectors: PageFill.selectorsFor(element), field, fieldType };
    if (element.type === 'checkbox' || element.type === 'radio') entry.checked = element.checked;
    if (element.type === 'file') {
      entry.files = Array.from(element.files || []).map((file) => ({
        name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
      }));
      entry.fixtureBinding = 'operator_selected_file';
    } else if (element.type === 'password' || Fields.SECRET_TYPES.has(fieldType)) {
      entry.secret = true;
      if (recordSecrets) entry.value = element.value;
      else entry.redacted = true;
    } else {
      entry.value = element.value;
      if (element.localName === 'select' && element.multiple) {
        entry.selectedValues = Array.from(element.selectedOptions, (option) => option.value);
      }
    }
    record(entry);
  }
  // Capture text before a framework can unmount the edited control. Native
  // input/change pairs remain observations; the converter folds edits at the
  // relevant action boundary instead of mistaking every keystroke for a write.
  document.addEventListener('input', (event) => {
    if (event.target instanceof Element && event.target.localName !== 'select' &&
        !['checkbox', 'radio', 'file'].includes(event.target.type)) fieldChanged(event);
  }, true);
  document.addEventListener('change', fieldChanged, true);
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.kind === 'inspect-fill' && window === window.top) {
      reply(PageFill.credentialNeeds(document));
      return false;
    }
    if (message.kind === 'recording') {
      setRecording(message.active, message.recordSecrets);
      Promise.resolve(activeFill).then(() => Promise.all([...pending])).then(() => reply({ flushed: true, failures: failures.slice() }));
      return true;
    }
    if (message.kind === 'fill' && window === window.top) {
      if (!recording) { reply({ error: 'Recording is not active' }); return false; }
      if (activeFill) { reply({ error: 'A fill is already running' }); return false; }
      fillController = new AbortController();
      const classify = (fields) => send({ kind: 'classify', fields }).then((answer) => answer.types || {});
      activeFill = PageFill.fillAll(document, { values: message.values, classify, signal: fillController.signal })
        .then(async (report) => {
          await record({ type: 'fill', filled: report.filled, manual: report.manual,
            interrupted: Boolean(report.interrupted), classifyError: report.classifyError }, true);
          reply({ report, url: location.href });
        })
        .catch(async (error) => {
          await record({ type: 'fill_error', error: error.message }, true);
          reply({ error: error.message });
        })
        .finally(() => { activeFill = null; fillController = null; });
      return true;
    }
    return false;
  });
  send({ kind: 'recording?' }).then((answer) => setRecording(answer.active, answer.recordSecrets))
    .catch((error) => failures.push(error.message));
})();
