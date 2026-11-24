// Page-side helpers: describe fields, compute selector candidates and fill
// forms through the native value setter so framework state sees the change.
// Requires TreadwayFields. Runs as a content script and in browser tests.
(function (root) {
  'use strict';

  const Fields = root.TreadwayFields;
  const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'range', 'color']);
  const MANUAL_ATTRIBUTE = 'data-treadway-manual';
  const classifiedFields = new WeakMap();
  const humanEdits = new WeakMap();
  const fillContexts = new WeakMap();
  const CONTROL_SELECTOR = 'input, textarea, select, [role="combobox"]';
  function contextFor(document) {
    return JSON.stringify({ url: document.location.href,
      step: root.TreadwayFormRuntime ? root.TreadwayFormRuntime('inspect').step.map(item => item.label) : [] });
  }
  function assertContext(document) {
    const expected = fillContexts.get(document);
    if (expected && expected !== contextFor(document)) throw new Error('form context changed');
  }

  function text(value, limit) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit || 120);
  }

  function labelFor(element) {
    if (element.labels && element.labels.length) return text(element.labels[0].innerText || element.labels[0].textContent);
    const labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      const parts = labelled.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)).filter(part => part && part !== element);
      if (parts.length) return text(parts.map((part) => part.textContent).join(' '));
    }
    return text(element.getAttribute('aria-label'));
  }

  function nearbyText(element) {
    let node = element.previousElementSibling;
    if (node && node.textContent.trim()) return text(node.textContent);
    node = element.parentElement;
    for (let depth = 0; node && depth < 2; depth += 1, node = node.parentElement) {
      const value = text(node.innerText || node.textContent);
      if (value) return value;
    }
    return '';
  }

  function cssEscape(value) {
    return root.CSS && root.CSS.escape ? root.CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&');
  }

  function cssPath(element) {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function accessibleName(element) {
    if (/^(input|select|textarea)$/.test(element.localName)) return labelFor(element);
    return text(element.getAttribute('aria-label') || element.innerText || element.textContent || element.getAttribute('title') || element.value, 80);
  }

  function roleOf(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || (tag === 'input' && /^(submit|button|reset)$/.test(element.type))) return 'button';
    if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      if (element.type === 'number') return 'spinbutton';
      if (element.type === 'range') return 'slider';
      if (element.type === 'search') return 'searchbox';
      if (/^(text|email|tel|url)$/.test(element.type)) return 'textbox';
      return null; // Passwords, files and dates have no portable implicit textbox role.
    }
    return explicit || null;
  }

  function attributeValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
  }

  // Several candidates so the agent can choose the most stable one later.
  function selectorsFor(element) {
    const selectors = { css: cssPath(element) };
    for (const attribute of ['data-testid', 'data-test-id']) {
      const value = element.getAttribute(attribute);
      if (value) { selectors.testId = '[' + attribute + '="' + attributeValue(value) + '"]'; break; }
    }
    if (element.id) selectors.id = '#' + cssEscape(element.id);
    const name = element.getAttribute('name');
    if (name) selectors.name = element.localName + '[name="' + attributeValue(name) + '"]';
    const label = accessibleName(element);
    const role = roleOf(element);
    if (label && role) selectors.role = { role, name: label };
    return selectors;
  }

  // Interactive element the person meant, rather than an inner span or icon.
  function actionTarget(element) {
    return (element.closest && element.closest('a, button, input, select, textarea, label, summary, [role], [onclick]')) || element;
  }

  function describeField(element) {
    const group = element.closest('[role="radiogroup"],fieldset');
    return {
      tag: element.localName,
      inputType: element.localName === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() :
        element.getAttribute('role') === 'combobox' ? 'combobox' : element.localName,
      name: element.getAttribute('name') || '',
      id: element.id || '',
      label: labelFor(element),
      placeholder: element.getAttribute('placeholder') || '',
      autocomplete: element.getAttribute('autocomplete') || '',
      nearby: nearbyText(element),
      groupLabel: group ? (labelFor(group) || text(group.querySelector('legend')?.textContent)) : '',
      options: element.localName === 'select' ? Array.from(element.options).map((option) => text(option.textContent, 40)).filter(Boolean) : undefined,
    };
  }

  function visible(element) {
    if (!element.isConnected || element.disabled || element.readOnly || element.getAttribute('aria-hidden') === 'true' ||
      element.getAttribute('aria-disabled') === 'true') return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function isEmpty(element) {
    if (element.getAttribute('role') === 'radiogroup') return ![...element.querySelectorAll('input[type="radio"]')].some(item => item.checked);
    if (element.type === 'radio') return !radioGroup(element).some(item => item.checked || humanEdits.has(item));
    if (element.type === 'checkbox') return !element.checked && !humanEdits.has(element);
    if (element.localName === 'select') return element.selectedIndex < 0 || !element.options[element.selectedIndex].value;
    if (element.getAttribute('role') === 'combobox' && element.localName !== 'input') {
      const backing = element.parentElement?.querySelector('input[aria-hidden="true"]');
      if (backing) return !backing.value;
      return !fieldValue(element) || /^(--\s*)?(please\s+)?(select|choose)(\s+.*|\s*--)?$/i.test(fieldValue(element));
    }
    return element.value === '';
  }
  function fieldValue(element) {
    if (['checkbox', 'radio'].includes(element.type)) return element.checked;
    return 'value' in element ? element.value : text(element.textContent).replace(/[\u200b\ufeff]/g, '').trim();
  }

  function fillableFields(document) {
    const radios = new Set();
    return Array.from(document.querySelectorAll(CONTROL_SELECTOR)).filter((element) => {
      if (element.localName === 'input' && SKIPPED_INPUT_TYPES.has((element.getAttribute('type') || 'text').toLowerCase())) return false;
      if (!visible(element) || !isEmpty(element)) return false;
      if (element.type === 'radio') {
        const group = radioGroup(element)[0];
        if (radios.has(group)) return false;
        radios.add(group);
      }
      return true;
    });
  }
  function radioGroup(element) {
    const scope = element.closest('[role="radiogroup"]') || element.form || element.ownerDocument;
    return [...scope.querySelectorAll('input[type="radio"]')].filter(candidate => candidate.name === element.name && candidate.form === element.form);
  }
  function noteHumanEdit(element) { humanEdits.set(element, (humanEdits.get(element) || 0) + 1); }
  function consent(element) {
    return element.type === 'checkbox' && /\bagree\b|\bconsent\b|\battest\b|\bcertify\b|accept.{0,20}terms|confirm.{0,30}(accur|truth|correct)/i.test(labelFor(element));
  }
  function choiceControl(element) {
    return element.localName === 'select' || ['radio', 'checkbox'].includes(element.type) || element.getAttribute('role') === 'combobox';
  }

  function nativeSetter(element) {
    const view = element.ownerDocument.defaultView;
    const prototype = { input: view.HTMLInputElement, textarea: view.HTMLTextAreaElement, select: view.HTMLSelectElement }[element.localName].prototype;
    return Object.getOwnPropertyDescriptor(prototype, 'value').set;
  }

  function selectOptionValue(element, value) {
    const options = Array.from(element.options).filter((option) => !option.disabled);
    const exact = options.filter((candidate) => candidate.value === String(value));
    if (exact.length === 1) return exact[0].value;
    const wanted = String(value).trim().toLowerCase();
    const labelled = options.filter((candidate) => text(candidate.textContent).toLowerCase() === wanted);
    if (exact.length > 1 || labelled.length > 1) throw new Error('ambiguous option');
    return labelled.length === 1 ? labelled[0].value : null;
  }

  // Sets the value as a person's edit would arrive: focus, value, input,
  // change, blur. Returns the value that should now be in the field.
  function setFieldValue(element, value) {
    let target = String(value);
    if (element.localName === 'select') {
      target = selectOptionValue(element, value);
      if (target === null) return null;
    }
    const view = element.ownerDocument.defaultView;
    element.focus();
    nativeSetter(element).call(element, target);
    element.dispatchEvent(new view.Event('input', { bubbles: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    element.blur();
    return target;
  }

  // Resolves once the DOM has been quiet for quietMs, or after maxMs.
  function waitForSettle(document, quietMs, maxMs) {
    const quiet = quietMs || 150;
    const limit = maxMs || 1500;
    return new Promise((resolve) => {
      let timer = null;
      const observer = new document.defaultView.MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quiet);
      });
      const deadline = setTimeout(finish, limit);
      function finish() {
        clearTimeout(timer);
        clearTimeout(deadline);
        observer.disconnect();
        resolve();
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(finish, quiet);
    });
  }

  function markManual(element, reason) {
    try { assertContext(element.ownerDocument); } catch (_) { return; }
    element.setAttribute(MANUAL_ATTRIBUTE, reason);
    element.style.setProperty('outline', '3px solid #d97706', 'important');
    element.style.setProperty('outline-offset', '1px', 'important');
    element.addEventListener('input', function clear(event) {
      if (!event.isTrusted) return;
      element.removeAttribute(MANUAL_ATTRIBUTE);
      element.style.removeProperty('outline');
      element.style.removeProperty('outline-offset');
      element.removeEventListener('input', clear);
    });
  }

  function retained(element, expected) {
    return element.isConnected && fieldValue(element) === expected;
  }
  function validationState(element, secret = false) {
    if (!element) return null;
    const ariaInvalid = element.getAttribute('aria-invalid');
    const native = element.willValidate && element.validity ? element.validity : null;
    const nativeIssues = native ? ['badInput', 'customError', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow',
      'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valueMissing'].filter(key => native[key]) : [];
    const ids = attribute => (element.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
    const messageIds = ids('aria-errormessage'), descriptionIds = ids('aria-describedby');
    const readText = references => secret ? [] : references.map(id => element.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean).map(value => text(value, 500));
    return { invalid: (ariaInvalid !== null && ariaInvalid !== 'false' && ariaInvalid !== '') || native?.valid === false,
      ariaInvalid, nativeValid: native ? native.valid : null, nativeIssues,
      ...(native && !native.valid && !secret ? { nativeMessage: text(element.validationMessage, 500) } : {}),
      messageIds, messages: readText(messageIds), descriptionIds, descriptions: readText(descriptionIds) };
  }

  function bindingFor(element) {
    const field = describeField(element);
    const form = element.form;
    return { tag: field.tag, inputType: field.inputType, id: field.id, name: field.name, label: field.label,
      formId: form ? form.id : '', formName: form ? form.getAttribute('name') || '' : '' };
  }
  function bindingKey(binding) { return JSON.stringify(binding); }
  function resolveField(document, binding) {
    const candidates = Array.from(document.querySelectorAll(CONTROL_SELECTOR))
      .filter((element) => element.isConnected && bindingKey(bindingFor(element)) === bindingKey(binding));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function rememberType(element, type) {
    if (!type) return;
    let types = classifiedFields.get(element.ownerDocument);
    if (!types) { types = new Map(); classifiedFields.set(element.ownerDocument, types); }
    types.set(bindingKey(bindingFor(element)), type);
  }
  function classifiedTypeFor(element) {
    return classifiedFields.get(element.ownerDocument)?.get(bindingKey(bindingFor(element))) || null;
  }
  function credentialNeeds(document) {
    const fields = Array.from(document.querySelectorAll('input')).filter(element =>
      visible(element) && !element.disabled && !element.readOnly && element.type === 'password');
    const newFields = fields.filter(element => Fields.ruleType(describeField(element))?.type === 'new_password');
    const forms = new Set(newFields.map(field => field.form));
    const signup = fields.filter(field => forms.has(field.form) && !currentPassword(describeField(field)));
    const limits = signup.map(element => element.maxLength).filter(value => value > 0);
    return { needsNewPassword: newFields.length > 0 && signup.some(isEmpty) && !signup.some(field => field.value),
      maximumLength: limits.length ? Math.min(...limits) : null };
  }
  function currentPassword(field) {
    return field.autocomplete.split(/\s+/).includes('current-password') ||
      /\b(current|old|existing)\b/.test(Fields.normalise([field.label, field.name, field.id].join(' ')));
  }
  function controlledContext(element) {
    const runtime = root.TreadwayFormRuntime;
    const snapshot = runtime('inspect');
    const fieldRef = runtime('locate', { selector: selectorsFor(element).css }).ref;
    if (!snapshot.listboxes.some(list => list.controllers.some(controller => controller.fieldRef === fieldRef))) return null;
    return { snapshot, fieldRef, ...root.TreadwayChoiceBinding.controlledBinding(snapshot, fieldRef) };
  }
  const optionKey = option => JSON.stringify([option.label, option.value ?? null]);
  const optionSet = options => JSON.stringify(options.map(optionKey).sort());
  function localOptions(element) {
    if (element.localName === 'select') return [...element.options].filter(option => !option.disabled &&
      !option.closest('optgroup[disabled]') && option.value !== '').map(option => ({ label: text(option.textContent, 300), value: option.value }));
    if (element.type === 'radio') return radioGroup(element).filter(visible).map(option =>
      ({ label: labelFor(option) || option.value, value: option.value, binding: bindingFor(option) }));
    if (element.type === 'checkbox') return [{ label: 'Checked', value: 'true' }, { label: 'Unchecked', value: 'false' }];
    return null;
  }
  function exactOption(options, value, element, type) {
    let wanted = String(value).trim().toLowerCase();
    if (element.type === 'radio') {
      if (wanted === 'true') wanted = 'yes';
      if (wanted === 'false') wanted = 'no';
    }
    if (element.type === 'checkbox') {
      // Negated labels need semantic matching unless the fact names that
      // exact statement. Do not invert a persona's meaning by guessing.
      if (Fields.normalise(labelFor(element)).replace(/[^a-z0-9 ]/g, '') !== Fields.normalise(type)) return null;
      if (/^(yes|true|1)$/.test(wanted)) wanted = 'true';
      if (/^(no|false|0)$/.test(wanted)) wanted = 'false';
    }
    const literal = element.type === 'checkbox' ? wanted : String(value);
    const byValue = options.map((option, index) => ({ option, index })).filter(({ option }) =>
      option.value !== null && option.value !== undefined && String(option.value) === literal);
    if (byValue.length > 1) throw new Error('ambiguous option');
    if (byValue.length === 1) return byValue[0].index;
    const indices = options.map((option, index) => ({ option, index })).filter(({ option }) =>
      option.label.toLowerCase() === wanted);
    if (indices.length > 1) throw new Error('ambiguous option');
    return indices.length ? indices[0].index : null;
  }
  function prepareReference(element) {
    assertContext(element.ownerDocument);
    if (!root.TreadwayFormRuntime) return null;
    const ref = root.TreadwayFormRuntime('locate', { selector: selectorsFor(element).css }).ref;
    if (!ref) throw new Error('field changed');
    return { ref, hit: root.TreadwayFormRuntime('prepare', { ref }) };
  }
  function busy(element, context) {
    return element.getAttribute('aria-busy') === 'true' ||
      Boolean(element.closest('[aria-busy="true"]')) || Boolean(context?.list.loading);
  }
  function listElement(document, context) {
    const id = context?.controller.controlId;
    const container = id ? [...document.querySelectorAll('[id]')].find(node => node.id === id) : null;
    if (!container) return null;
    return container.matches('[role="listbox"]') ? container : container.querySelector('[role="listbox"]');
  }
  async function closeChoices(document, binding, query, signal, editEpoch = 0) {
    assertContext(document);
    const element = resolveField(document, binding);
    if (!element) return;
    let context;
    try { context = controlledContext(element); } catch (_) { return; }
    const target = listElement(document, context) || element;
    target.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    // Restore only our own uncommitted search text, never human input.
    if (element.localName === 'input' && element.value === query && (humanEdits.get(element) || 0) === editEpoch) {
      nativeSetter(element).call(element, '');
      element.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
      element.blur();
      // Some widgets reopen on an empty input event; dismiss only this
      // controller's newly observed popup after restoring our query.
      if (element.getAttribute('aria-expanded') === 'true') {
        const reopened = controlledContext(element);
        (listElement(document, reopened) || element).dispatchEvent(new document.defaultView.KeyboardEvent('keydown',
          { key: 'Escape', code: 'Escape', bubbles: true }));
      }
    }
    const deadline = Date.now() + 1000;
    do {
      await abortable(waitForSettle(document, 50, 100), signal);
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (element.getAttribute('aria-expanded') !== 'true' && (hit === element || element.contains(hit))) break;
    } while (Date.now() < deadline && !signal?.aborted);
    if (element.getAttribute('aria-expanded') === 'true') throw new Error('choice popup did not close');
  }
  async function observeChoices(document, binding, value, signal, { retain = false, continued } = {}) {
    let element = resolveField(document, binding);
    if (!element || !visible(element) || (!isEmpty(element) && !continued)) throw new Error('field changed');
    const local = localOptions(element);
    if (local) return { options: local, kind: element.type || element.localName };
    prepareReference(element);
    const view = document.defaultView;
    const query = element.localName === 'input' ? String(value) : '';
    const editEpoch = continued?.editEpoch ?? (humanEdits.get(element) || 0);
    if (continued && ((element.localName === 'input' && element.value !== query) || (humanEdits.get(element) || 0) !== editEpoch)) throw new Error('field changed');
    if (!continued) element.focus();
    if (!continued && element.localName === 'input') {
      nativeSetter(element).call(element, query);
      element.dispatchEvent(new view.InputEvent('input', { inputType: 'insertText', data: query, bubbles: true }));
    } else if (!continued) {
      element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      element.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, button: 0 }));
      element.click();
    }
    let context; let options = []; let loading = false; let observed = false;
    const deadline = Date.now() + (root.TreadwayChoiceBinding?.DEFAULT_WINDOW_MS || 15000);
    try {
      do {
        if (signal?.aborted) throw new Error('recording stopped');
        element = resolveField(document, binding);
        if (!element || !visible(element) || (humanEdits.get(element) || 0) !== editEpoch) throw new Error('field changed');
        context = controlledContext(element);
        loading = busy(element, context);
        options = (context?.list.options || []).filter(option => option.visible && !option.disabled)
          .map(option => ({ label: option.label, value: option.value ?? null, ref: option.ref }));
        if (options.length && !loading) break;
        if (element.getAttribute('aria-expanded') === 'false' && element.localName === 'input' && element.value !== query) throw new Error('query was not retained');
        await abortable(new Promise(resolve => setTimeout(resolve, 100)), signal);
      } while (Date.now() < deadline);
      const observation = { options, loading, context, kind: 'combobox', query, editEpoch,
        error: options.length ? '' : loading ? 'options still loading' : context ? 'no matching option' : 'no controlled list' };
      observed = true;
      if (retain && options.length && !loading) return observation;
      return observation;
    } finally {
      if (!retain || !observed) await closeChoices(document, binding, query, signal, editEpoch);
    }
  }
  async function applyChoice(document, plan, signal) {
    assertContext(document);
    let element = resolveField(document, plan.binding);
    if (!element || !visible(element) || !isEmpty(element)) throw new Error('field changed');
    const chosen = plan.observation.options[plan.optionIndex];
    if (!chosen) throw new Error('no matching option');
    if (element.localName === 'select') {
      const current = localOptions(element);
      if (optionSet(current) !== optionSet(plan.observation.options)) throw new Error('options changed');
      const reference = prepareReference(element);
      if (reference) root.TreadwayFormRuntime('select', { ref: reference.ref, value: chosen.value });
      else setFieldValue(element, chosen.value);
      return { binding: plan.binding, expected: chosen.value };
    }
    if (['checkbox', 'radio'].includes(element.type)) {
      if (element.type === 'radio') {
        if (optionSet(localOptions(element)) !== optionSet(plan.observation.options)) throw new Error('options changed');
        element = resolveField(document, chosen.binding);
        if (!element || radioGroup(element).some(item => item.checked || humanEdits.has(item))) throw new Error('field changed');
      } else if (humanEdits.has(element) || consent(element)) throw new Error('operator decision');
      const expected = element.type === 'radio' || chosen.value === 'true';
      if (element.checked !== expected) {
        const reference = prepareReference(element);
        const target = reference ? document.elementFromPoint(reference.hit.x, reference.hit.y) : element;
        target.click();
      }
      return { binding: bindingFor(element), expected };
    }
    const current = await observeChoices(document, plan.binding, plan.value, signal, { retain: true });
    try {
      if (optionSet(current.options) !== optionSet(plan.observation.options)) throw new Error('options changed');
      const matches = current.options.filter(option => optionKey(option) === optionKey(chosen));
      if (matches.length !== 1) throw new Error('ambiguous option');
      const option = matches[0];
      const choice = root.TreadwayChoiceBinding.choiceContext(current.context.snapshot, current.context.fieldRef, option.ref);
      const hit = root.TreadwayFormRuntime('prepare', { ref: option.ref, choice: choice.binding });
      const target = document.elementFromPoint(hit.x, hit.y)?.closest('[role="option"]');
      if (!target) throw new Error('field changed');
      target.click();
      await abortable(waitForSettle(document), signal);
      return { binding: plan.binding, expected: option.label };
    } catch (error) {
      await closeChoices(document, plan.binding, current.query, signal, current.editEpoch);
      throw error;
    }
  }
  async function abortable(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return undefined;
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); resolve(undefined); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
  }

  // values: {fieldType: {value, source}}. classify(fields) resolves to
  // {key: {type, confidence}} for fields the rules could not type.
  // Fills empty fields one at a time and repeats while new fields appear.
  async function fillAll(document, options) {
    if (fillContexts.has(document)) throw new Error('A fill is already running');
    fillContexts.set(document, contextFor(document));
    try { return await fillImplementation(document, options); }
    finally { fillContexts.delete(document); }
  }
  async function fillImplementation(document, { values, classify, decide, progress = () => {}, rounds, signal }) {
    const report = { filled: [], manual: [], decisions: [], batches: [] };
    const seen = new Set();
    const completed = [];
    for (let round = 0; round < (rounds || 3); round += 1) {
      if (signal?.aborted) { report.interrupted = true; break; }
      const elements = fillableFields(document).filter((element) => !seen.has(bindingKey(bindingFor(element))));
      if (!elements.length) break;
      const plans = elements.map((element, index) => {
        const binding = bindingFor(element);
        seen.add(bindingKey(binding));
        const field = describeField(element);
        const rule = Fields.ruleType(field);
        const exactFact = Object.keys(values).filter(type => !Fields.SECRET_TYPES.has(type) &&
          [field.name, field.id, field.label, field.groupLabel].some(label =>
            Fields.normalise(label).replace(/[^a-z0-9 ]/g, '').trim() === Fields.normalise(type)));
        const direct = !Fields.SECRET_TYPES.has(rule?.type) && exactFact.length === 1 ? exactFact[0] : null;
        return { binding, field, key: 'f' + round + '_' + index,
          type: direct || rule?.type, by: direct ? 'persona key' : rule?.by,
          unsupported: element.type === 'file' ? 'file requires operator' : consent(element) ? 'operator decision' : null };
      });
      // A plain Password beside Confirm/New password belongs to that signup
      // group. An explicit current-password autocomplete keeps its own binding.
      for (const plan of plans) {
        if (plan.type !== 'password' || currentPassword(plan.field)) continue;
        const element = resolveField(document, plan.binding);
        if (plans.some(other => other.type === 'new_password' &&
          resolveField(document, other.binding)?.form === element?.form)) plan.type = 'new_password';
      }
      // A rule's generic type can differ from the persona's more specific key
      // (phone vs mobile_phone, region vs county). Let Jev resolve these too;
      // a recognized label alone must not prevent using the available data.
      const unknown = plans.filter((plan) => !plan.unsupported &&
        (!plan.type || (!values[plan.type] && !plan.type.startsWith('previous_'))));
      if (unknown.length && classify) {
        let answers = {};
        progress('classify', unknown.length);
        const started = Date.now();
        try {
          answers = await abortable(classify(unknown.map((plan) => Object.assign({ key: plan.key }, plan.field))), signal) || {};
        } catch (error) {
          report.classifyError = error.message;
        }
        for (const plan of unknown) {
          if (answers[plan.key]) Object.assign(plan, { type: answers[plan.key].type, by: 'jev', confidence: answers[plan.key].confidence, fit: answers[plan.key].fit });
        }
        report.batches.push({ phase: 'classify', count: unknown.length, elapsedMs: Date.now() - started });
      }
      // Observe widget options first, then resolve independent semantic matches
      // in ONE model request. No per-option or per-poll inference loop.
      const jobs = [];
      const jobFor = plan => ({ key: plan.key, field: plan.field, type: plan.type, intent: String(plan.value),
        options: plan.observation.options.map(option => ({ label: option.label })),
        loading: plan.observation.loading, error: plan.observation.error });
      async function resolveDecisions(batch) {
        if (!batch.length || !decide || signal?.aborted) return;
        progress('decide', batch.length);
        const started = Date.now(); let answers = {}; let batchError;
        try { answers = await abortable(decide(batch), signal) || {}; }
        catch (error) { batchError = error.message; report.decisionError = error.message; }
        report.batches.push({ phase: 'decide', count: batch.length, elapsedMs: Date.now() - started });
        for (const job of batch) {
          const plan = plans.find(plan => plan.key === job.key);
          const answer = answers[job.key];
          plan.decisionAction = answer?.action;
          if (answer?.action === 'select' && Number.isInteger(answer.index) && answer.index >= 0 && answer.index < job.options.length) {
            const selected = plan.observation.options[answer.index];
            if (plan.observation.options.filter(option => option.label.slice(0, 300) === selected.label.slice(0, 300)).length !== 1) {
              plan.choiceError = 'ambiguous option';
            } else {
              plan.optionIndex = answer.index; plan.choiceError = null;
              plan.optionDecision = { action: 'select', confidence: answer.confidence, fit: answer.fit, label: selected.label };
            }
          } else plan.choiceError = batchError ? 'decision service unavailable' :
            answer?.action === 'wait' ? 'options still loading' : 'option match not confirmed';
          report.decisions.push({ field: plan.field, type: plan.type, source: 'jev',
            ...(plan.optionDecision || { action: answer?.action || 'manual', reason: plan.choiceError }) });
        }
      }
      progress('inspect', plans.length);
      for (const plan of plans) {
        if (signal?.aborted) break;
        const element = resolveField(document, plan.binding);
        if (plan.unsupported || !element || !visible(element) || !isEmpty(element) ||
          !choiceControl(element) || element.multiple || !values[plan.type] || Fields.SECRET_TYPES.has(plan.type)) continue;
        plan.value = Fields.formatValue(plan.type, values[plan.type].value, plan.field);
        let observation;
        try {
          observation = await observeChoices(document, plan.binding, plan.value, signal, { retain: true });
          plan.observation = observation;
          // A loading decision is a real state dependency: retain the pending
          // lookup, ask Jev once, then observe without retyping the query.
          if (observation.loading && decide) {
            await resolveDecisions([...jobs.splice(0), jobFor(plan)]);
            if (plan.decisionAction === 'wait') {
              progress('inspect', 1);
              observation = await observeChoices(document, plan.binding, plan.value, signal,
                { retain: true, continued: observation });
              plan.observation = observation;
            }
          }
          plan.field = { ...plan.field, options: observation.options.map(option => option.label) };
          if (observation.error) { plan.choiceError = observation.error; continue; }
          if (observation.options.length > 255) { plan.choiceError = 'too many options; narrow the lookup'; continue; }
          plan.choiceError = null;
          plan.optionIndex = exactOption(observation.options, plan.value, element, plan.type);
          if (plan.optionIndex === null && decide &&
            !/password|secret|token|one.?time|\botp\b|api.?key|^card_|ppsn|email|phone|username/i.test(plan.type)) jobs.push(jobFor(plan));
        } catch (error) { plan.choiceError = error.message; }
        finally {
          if (observation?.kind === 'combobox') {
            try { await closeChoices(document, plan.binding, observation.query, signal, observation.editEpoch); }
            catch (error) { plan.choiceError = error.message; }
          }
        }
      }
      await resolveDecisions(jobs);
      progress('apply', plans.length);
      for (const plan of plans) {
        if (signal?.aborted) { report.interrupted = true; break; }
        const element = resolveField(document, plan.binding);
        const entry = { selectors: element ? selectorsFor(element) : {}, field: plan.field, binding: plan.binding,
          type: plan.type || null, by: plan.by || null };
        if (element) rememberType(element, plan.type);
        if (plan.confidence !== undefined) entry.confidence = plan.confidence;
        if (plan.fit !== undefined) entry.fit = plan.fit;
        let reason = plan.unsupported || plan.choiceError || null;
        if (!reason) {
          if (!element || !visible(element)) reason = 'field changed';
          else if (element.localName === 'select' && element.multiple) reason = 'multiple selection requires human';
          else if (!plan.type) reason = 'unclassified';
          else if (Fields.SECRET_TYPES.has(plan.type) && (!values[plan.type]?.credential ||
            plan.type === 'one_time_code' || (element.type !== 'password' &&
              !['new-password', 'current-password'].includes(plan.field.autocomplete)))) reason = 'secret';
          else if (!values[plan.type]) reason = 'no persona value';
        }
        if (!reason && plan.type === 'new_password') {
          const existing = Array.from(document.querySelectorAll('input[type=password]')).filter(candidate =>
            candidate.form === element.form && visible(candidate) && candidate.value &&
            !currentPassword(describeField(candidate)) && Fields.ruleType(describeField(candidate))?.type !== 'one_time_code');
          if (existing.some(candidate => candidate.value !== values[plan.type].value)) reason = 'saved password differs from existing input';
        }
        if (!reason && !isEmpty(element)) continue;
        if (!reason && choiceControl(element) && (!plan.observation || plan.optionIndex === null || plan.optionIndex === undefined)) reason = 'no matching option';
        if (!reason) {
          const value = Fields.formatValue(plan.type, values[plan.type].value, plan.field);
          let expected;
          let resultBinding = plan.binding;
          try {
            if (choiceControl(element)) {
              const applied = await applyChoice(document, plan, signal);
              resultBinding = applied.binding; expected = applied.expected;
            } else {
              prepareReference(element);
              expected = setFieldValue(element, value);
            }
          } catch (error) { reason = error.message; }
          await abortable(waitForSettle(document), signal);
          const live = resolveField(document, resultBinding);
          Object.assign(entry, { value, expectedValue: expected ?? null, observedValue: live ? fieldValue(live) : null,
            retained: Boolean(live && retained(live, expected)), validation: validationState(live, Fields.SECRET_TYPES.has(plan.type)),
            source: values[plan.type].source });
          if (Fields.SECRET_TYPES.has(plan.type)) Object.assign(entry, { secret: true, secretReference: values[plan.type].secretReference });
          if (signal?.aborted) { report.interrupted = true; reason = 'recording stopped'; }
          else if (!reason && expected === null) reason = 'no matching option';
          else if (!reason && !entry.retained) reason = 'did not stick';
          else if (!reason && entry.validation?.invalid) reason = 'validation error';
          if (!reason) {
            rememberType(live, plan.type);
            const filled = Object.assign(entry, { selectors: selectorsFor(live), field: describeField(live), binding: resultBinding, value,
              expectedValue: expected, observedValue: fieldValue(live), source: values[plan.type].source });
            if (plan.optionDecision) filled.optionDecision = plan.optionDecision;
            if (Fields.SECRET_TYPES.has(plan.type)) Object.assign(filled, {
              secret: true, secretReference: values[plan.type].secretReference });
            report.filled.push(filled);
            completed.push({ binding: resultBinding, expected, entry: filled });
            continue;
          }
        }
        const current = resolveField(document, plan.binding);
        if (current) markManual(current, reason);
        report.manual.push(Object.assign(entry, { reason }));
      }
    }
    // A later field can reset an earlier one. Verify the final live form too.
    for (const item of completed) {
      const live = resolveField(document, item.binding);
      const valueRetained = Boolean(live && retained(live, item.expected));
      const validation = validationState(live, Fields.SECRET_TYPES.has(item.entry.type));
      Object.assign(item.entry, { retained: valueRetained, validation, observedValue: live ? fieldValue(live) : null });
      if (!valueRetained || validation?.invalid) {
        const reason = valueRetained ? 'validation error' : 'did not stick';
        report.filled = report.filled.filter((entry) => entry !== item.entry);
        if (live) markManual(live, reason);
        report.manual.push(Object.assign({}, item.entry, { reason }));
      }
    }
    // Later React remounts can remove a previous manual highlight.
    report.skipped = [];
    report.manual = report.manual.filter(entry => {
      const live = resolveField(document, entry.binding);
      if (live?.disabled) { report.skipped.push({ ...entry, reason: 'control disabled after fill' }); return false; }
      if (live) markManual(live, entry.reason);
      return true;
    });
    progress('done', report.filled.length);
    return report;
  }

  const api = { describeField, selectorsFor, actionTarget, fillableFields, setFieldValue, waitForSettle, fillAll,
    classifiedTypeFor, bindingFor, resolveField, credentialNeeds, noteHumanEdit, isEmpty, fieldValue, MANUAL_ATTRIBUTE };
  root.TreadwayPageFill = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
