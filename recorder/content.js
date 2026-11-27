// Page observations, including a drainable journal and interruptible Fill all.
(function () {
  'use strict';
  const attachmentKey = '__treadwayRecorderAttachment';
  if (globalThis[attachmentKey]?.alive?.()) return;
  const PageFill = globalThis.TreadwayPageFill;
  const Fields = globalThis.TreadwayFields;
  const attachedRuntime = chrome.runtime, extensionId = attachedRuntime.id;
  const contentVersion = attachedRuntime.getManifest().version;
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
      documentInstanceId, contentVersion, url: location.href, frame: window === window.top ? 'top' : 'child',
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
    if (!event.isTrusted || PageFill.isOwnAction(event) || !(event.target instanceof Element)) return;
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
    if (!event.isTrusted || PageFill.isOwnAction(event) || !(element instanceof Element) || !/^(input|select|textarea)$/.test(element.localName)) return;
    PageFill.noteHumanEdit(element);
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
    const formContext = () => JSON.stringify({ url: location.href, steps: globalThis.TreadwayFormRuntime('inspect').step.map(item => item.label) });
    if (message.kind === 'journey-page-context') {
      reply({ site: location.origin, path: location.pathname, title: document.title,
        headings: [...document.querySelectorAll('h1,h2')].filter(element => element.getBoundingClientRect().width)
          .slice(0, 6).map(element => element.textContent.trim().slice(0, 200)) }); return false;
    }
    if (message.kind === 'recorder-readiness') {
      reply({ ready: true, version: contentVersion, documentInstanceId, url: location.href }); return false;
    }
    if (message.kind === 'highlight-field') {
      const element = PageFill.resolveField(document, message.binding);
      if (!element) { reply({ error: 'The field changed or its binding is ambiguous' }); return false; }
      element.scrollIntoView({ behavior: 'instant', block: 'center' });
      const previous = element.style.outline;
      element.style.outline = '3px solid #c77b00';
      setTimeout(() => { if (element.style.outline === 'rgb(199, 123, 0) solid 3px' || element.style.outline === '3px solid rgb(199, 123, 0)') element.style.outline = previous; }, 2000);
      reply({ highlighted: true }); return false;
    }
    if (message.kind === 'inspect-assistance' && window === window.top) {
      reply({ url: location.href, documentInstanceId, formContext: formContext(),
        fields: [...document.querySelectorAll('input,textarea,select,[role="combobox"],[role="radiogroup"]')]
          .filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height &&
            element.getAttribute('aria-hidden') !== 'true' && element.type !== 'hidden')
          .map(element => {
            const field = PageFill.describeField(element);
            const secret = element.type === 'password' || Fields.SECRET_TYPES.has(Fields.ruleType(field)?.type);
            return { field, binding: PageFill.bindingFor(element), selectors: PageFill.selectorsFor(element), role: element.getAttribute('role'),
              required: field.required,
              disabled: element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
              hasValue: !PageFill.isEmpty(element),
              ...(secret ? { secret: true } : { value: PageFill.fieldValue(element),
                ...(['radio', 'checkbox'].includes(element.type) ? { checked: element.checked } : {}) }) };
          }) });
      return false;
    }
    if (message.kind === 'inspect-fill' && window === window.top) {
      reply(PageFill.credentialNeeds(document));
      return false;
    }
    if (message.kind === 'recording') {
      setRecording(message.active, message.recordSecrets);
      Promise.resolve(activeFill).then(() => Promise.all([...pending])).then(() => reply({ flushed: true, failures: failures.slice() }));
      return true;
    }
    if (message.kind === 'cancel-fill') {
      fillController?.abort(); reply({ cancelled: Boolean(fillController) }); return false;
    }
    if (message.kind === 'fill' && window === window.top) {
      if (!recording) { reply({ error: 'Recording is not active' }); return false; }
      if (activeFill) { reply({ error: 'A fill is already running' }); return false; }
      if (message.expectedDocumentInstanceId && (message.expectedDocumentInstanceId !== documentInstanceId || message.expectedUrl !== location.href ||
          message.expectedFormContext && message.expectedFormContext !== formContext())) {
        reply({ error: 'The form changed while preparing missing values' }); return false;
      }
      fillController = new AbortController();
      const classify = (fields) => send({ kind: 'classify', fields, fillToken: message.fillToken }).then((answer) => answer.types || {});
      const decide = (jobs) => send({ kind: 'decide', jobs, fillToken: message.fillToken }).then((answer) => answer.decisions || {});
      const progress = (phase, count) => send({ kind: 'fill-progress', phase, count }).catch(() => undefined);
      const awaitDependencies = () => send({ kind: 'fill-await-dependencies', fillToken: message.fillToken }).then(answer => {
        if (!answer.ready) throw new Error('Dependent requests have not completed');
      });
      activeFill = PageFill.fillAll(document, { values: message.values, profile: message.profile,
        boundValues: message.boundValues, historyBindings: message.historyBindings, previousReport: message.previousReport,
        classify, decide, progress, awaitDependencies, signal: fillController.signal })
        .then(async (report) => {
          await record({ type: 'fill', filled: report.filled, manual: report.manual,
            decisions: report.decisions, batches: report.batches, skipped: report.skipped,
            deductions: report.deductions, personaRevision: message.profile?.revision,
            blocked: report.blocked, execution: report.execution,
            interrupted: Boolean(report.interrupted), classifyError: report.classifyError, decisionError: report.decisionError }, true);
          reply({ report, url: location.href, documentInstanceId, formContext: formContext() });
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
  globalThis[attachmentKey] = { documentInstanceId, version: contentVersion, alive() {
    try { return attachedRuntime.id === extensionId && attachedRuntime.getManifest().version === contentVersion; }
    catch (_) { return false; }
  } };
  send({ kind: 'recording?' }).then((answer) => setRecording(answer.active, answer.recordSecrets))
    .catch((error) => failures.push(error.message));
})();
