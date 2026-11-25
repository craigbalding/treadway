// Page-side helpers: describe fields, compute selector candidates and fill
// forms through the native value setter so framework state sees the change.
// Requires TreadwayFields. Runs as a content script and in browser tests.
(function (root) {
  'use strict';
  // Manifest document_idle injection can follow an explicit receiver repair.
  // Keep the live attachment's own-action/human-edit WeakMaps intact.
  if (root.__treadwayRecorderAttachment?.alive?.()) return;

  const Fields = root.TreadwayFields;
  const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'range', 'color']);
  const MANUAL_ATTRIBUTE = 'data-treadway-manual';
  const classifiedFields = new WeakMap();
  const humanEdits = new WeakMap();
  const ownActions = new WeakMap();
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
      required: Boolean(element.required || element.getAttribute('aria-required') === 'true' ||
        element.closest('[role="radiogroup"][aria-required="true"]') ||
        element.type === 'radio' && radioGroup(element).some(item => item.required)),
      options: element.localName === 'select' ? Array.from(element.options).map((option) => text(option.textContent, 40)).filter(Boolean) : undefined,
    };
  }

  function visible(element) {
    if (!element.isConnected || element.disabled || element.matches(':disabled') || element.readOnly || element.getAttribute('aria-hidden') === 'true' ||
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
  // Reading order follows visible related groups first, then their controls.
  // DOM order breaks geometric ties; it is not evidence of visual sequence.
  function orderedFields(document, { includePopulated = false } = {}) {
    const fields = includePopulated ? [...document.querySelectorAll(CONTROL_SELECTOR)].filter(element =>
      !(element.localName === 'input' && SKIPPED_INPUT_TYPES.has((element.getAttribute('type') || 'text').toLowerCase())) && visible(element)) : fillableFields(document);
    const position = element => {
      const rect = element.getBoundingClientRect();
      // Inline controls share a text baseline, not necessarily a top edge: a
      // tall textarea can extend above an input on the very same labelled row.
      // Use only one visible wrapping label and its unambiguous field-containing
      // fragment. Detached/multiple labels and wrapped fragments that overlap
      // horizontally provide no reliable row anchor, so retain control geometry.
      const label = element.labels?.length === 1 && element.labels[0].contains(element) && visible(element.labels[0]) ? element.labels[0] : null;
      const centre = rect.left + rect.width / 2;
      const fragments = label ? [...label.getClientRects()].filter(fragment => fragment.width > 0 && fragment.height > 0 &&
        centre >= fragment.left && centre <= fragment.right) : [];
      const row = fragments.length === 1 ? fragments[0] : rect;
      return { top: row.top, left: rect.left, bottom: row.bottom };
    };
    const compare = (a, b) => {
      const pa = position(a), pb = position(b);
      // Controls on the same visual row follow the document's writing direction.
      if (Math.abs(pa.top - pb.top) > 8) return pa.top - pb.top;
      const rtl = document.defaultView.getComputedStyle(a).direction === 'rtl';
      return (rtl ? -1 : 1) * (pa.left - pb.left);
    };
    const groupFor = element => element.closest('fieldset,[role="group"],[role="radiogroup"]');
    return fields.sort((a, b) => compare(groupFor(a) || a, groupFor(b) || b) || compare(a, b));
  }
  function observablePending(document, element) {
    const scope = element?.form || element?.closest('form,[role="form"]') || document;
    const nodes = [...scope.querySelectorAll('[aria-busy="true"],[role="progressbar"]')];
    if (scope.nodeType === 1 && scope.matches('[aria-busy="true"],[role="progressbar"]')) nodes.unshift(scope);
    return nodes.some(node => {
      if (!node.isConnected || node.getAttribute('aria-hidden') === 'true') return false;
      const style = document.defaultView.getComputedStyle(node), box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    });
  }
  async function waitForDependencies(document, binding, field, callback, signal) {
    // The host can supply request-aware readiness; DOM quiet alone cannot prove
    // that an asynchronous validation or dependent lookup has completed.
    if (callback) await abortable(callback({ binding, field }, signal), signal);
    const deadline = Date.now() + 15000;
    while (!signal?.aborted) {
      assertContext(document);
      const live = resolveField(document, binding);
      if (!observablePending(document, live)) {
        await abortable(waitForSettle(document), signal);
        if (!observablePending(document, resolveField(document, binding))) return;
      }
      if (Date.now() >= deadline) throw new Error('dependent form update still pending');
      await abortable(new Promise(resolve => setTimeout(resolve, 50)), signal);
    }
  }
  function explicitValue(binding, type, values, profile, boundValues, historyBindings) {
    const key = bindingKey(binding);
    const matches = entries => (entries || []).filter(item => item?.binding && bindingKey(item.binding) === key);
    const histories = matches(historyBindings);
    if (histories.length > 1) return { error: 'ambiguous persona history binding' };
    if (histories.length) {
      const link = histories[0];
      const record = profile?.context?.histories?.[link.historyKind]?.filter(item => item.id === link.recordId);
      const factType = link.factType || type;
      const value = record?.length === 1 ? record[0][factType] : undefined;
      if (!factType || Fields.SECRET_TYPES.has(factType) || !['string', 'number', 'boolean'].includes(typeof value)) {
        return { error: 'persona history binding has no scalar value' };
      }
      return { type: link.type || type || factType, entry: { value: String(value), source: 'persona history' },
        historyBinding: { historyKind: link.historyKind, recordId: link.recordId, factType } };
    }
    const supplied = matches(boundValues);
    if (supplied.length > 1) return { error: 'ambiguous field value binding' };
    if (!supplied.length) return null;
    const value = supplied[0];
    if (!value.type || Fields.SECRET_TYPES.has(value.type) || typeof value.value !== 'string' || !value.value ||
      values[type] && values[type].value !== value.value || values[value.type] && values[value.type].value !== value.value) return null;
    return { type: value.type, entry: { value: value.value, source: value.source || 'bound value' } };
  }
  function radioGroup(element) {
    const scope = element.closest('[role="radiogroup"]') || element.form || element.ownerDocument;
    return [...scope.querySelectorAll('input[type="radio"]')].filter(candidate => candidate.name === element.name && candidate.form === element.form);
  }
  // Native click() can synchronously emit trusted input/change events. Mark
  // only our synchronous action stack, never the asynchronous Fill lifetime:
  // genuine operator input while a provider request waits must still win.
  function isOwnAction(eventOrElement) {
    const element = eventOrElement?.target || eventOrElement;
    return Boolean(ownActions.get(element?.ownerDocument));
  }
  function ownAction(element, action) {
    const document = element.ownerDocument;
    ownActions.set(document, (ownActions.get(document) || 0) + 1);
    try { return action(); }
    finally {
      const depth = ownActions.get(document) - 1;
      if (depth) ownActions.set(document, depth); else ownActions.delete(document);
    }
  }
  function noteHumanEdit(element) {
    if (!isOwnAction(element)) humanEdits.set(element, (humanEdits.get(element) || 0) + 1);
  }
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
    ownAction(element, () => {
      element.focus();
      nativeSetter(element).call(element, target);
      element.dispatchEvent(new view.Event('input', { bubbles: true }));
      element.dispatchEvent(new view.Event('change', { bubbles: true }));
      element.blur();
    });
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
      if (!event.isTrusted || isOwnAction(event)) return;
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
    // Required decorations can appear when another field changes. Preserve
    // their raw observed label, but do not treat a trailing asterisk as a new
    // control identity. All other binding parts and uniqueness checks remain.
    const label = field.label.replace(/\s*\*+\s*$/, '').trim();
    return { tag: field.tag, inputType: field.inputType, id: field.id, name: field.name, label,
      formId: form ? form.id : '', formName: form ? form.getAttribute('name') || '' : '' };
  }
  function bindingKey(binding) {
    // Transport/schema serializers may reorder keys; identity is the complete
    // set of binding parts, not JavaScript property insertion order.
    if (!binding || typeof binding !== 'object') return 'null';
    return JSON.stringify(Object.fromEntries(['tag', 'inputType', 'id', 'name', 'label', 'formId', 'formName']
      .map(key => [key, binding[key]])));
  }
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
  function shortHash(value) {
    let hash = 2166136261;
    for (const char of value) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  function directFactType(field, values, rule) {
    const exact = Object.keys(values).filter(type => !Fields.SECRET_TYPES.has(type) &&
      [field.name, field.id, field.label, field.groupLabel].some(label =>
        Fields.normalise(label).replace(/[^a-z0-9 ]/g, '').trim() === Fields.normalise(type)));
    return !Fields.SECRET_TYPES.has(rule?.type) && exact.length === 1 ? exact[0] : null;
  }
  function deductionBinding(document, binding, field) {
    const scope = document.location.origin + document.location.pathname;
    // A SPA may reuse the same control on several steps at the same path.
    // Hash the observed context rather than persisting query strings or nearby
    // text (which can contain private values) in the deduction identity.
    const steps = root.TreadwayFormRuntime ? root.TreadwayFormRuntime('inspect').step.map(item => item.label) : [];
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).slice(0, 20).map(node => text(node.textContent));
    const context = shortHash(JSON.stringify({ steps, headings, nearby: field.nearby || '', label: field.label || '',
      placeholder: field.placeholder || '', autocomplete: field.autocomplete || '', inputType: field.inputType || '' }));
    const fieldBinding = JSON.stringify({ scope, binding, groupLabel: field.groupLabel || '', context });
    return { key: 'field-' + shortHash(fieldBinding), scope, fieldBinding };
  }
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
    ownAction(target, () => target.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })));
    // Restore only our own uncommitted search text, never human input.
    if (element.localName === 'input' && element.value === query && (humanEdits.get(element) || 0) === editEpoch) {
      ownAction(element, () => {
        nativeSetter(element).call(element, '');
        element.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
        element.blur();
      });
      // Some widgets reopen on an empty input event; dismiss only this
      // controller's newly observed popup after restoring our query.
      if (element.getAttribute('aria-expanded') === 'true') {
        const reopened = controlledContext(element);
        ownAction(element, () => (listElement(document, reopened) || element).dispatchEvent(new document.defaultView.KeyboardEvent('keydown',
          { key: 'Escape', code: 'Escape', bubbles: true })));
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
  // Bounded structural evidence for failed lookups. Never retain query text,
  // values, labels, selectors or active-element identifiers in this trace.
  function queryDiagnostics(document, binding, initial, query) {
    const limit = 24, trace = [], started = Date.now();
    const roles = new Set(['button', 'checkbox', 'combobox', 'dialog', 'listbox', 'option', 'radio', 'searchbox', 'textbox']);
    const tags = new Set(['a', 'body', 'button', 'dialog', 'div', 'html', 'iframe', 'input', 'li', 'select', 'span', 'textarea', 'ul']);
    let dropped = 0, optionCount = 0, observedLoading = false;
    function sample(phase, observation = {}) {
      if (observation.optionCount !== undefined) optionCount = observation.optionCount;
      if (observation.loading !== undefined) observedLoading = observation.loading;
      const live = 'element' in observation ? observation.element : resolveField(document, binding);
      const active = document.activeElement;
      const role = active?.getAttribute('role');
      const value = live && 'value' in live && typeof live.value === 'string' ? live.value : null;
      const expanded = live?.getAttribute('aria-expanded');
      const entry = { phase, elapsedMs: Date.now() - started, documentFocused: document.hasFocus(),
        bindingAvailable: Boolean(live), initialConnected: initial.isConnected, sameNode: live === initial,
        connected: Boolean(live?.isConnected), controlActive: Boolean(live && (active === live || live.contains(active))),
        activeElement: { tag: active ? (tags.has(active.localName) ? active.localName : 'other') : null, role: roles.has(role) ? role : null,
          type: active?.localName === 'input' ? active.type : null },
        queryMatches: value === null ? null : value === query, valueLength: value?.length ?? null,
        expanded: expanded === 'true' || expanded === 'false' ? expanded : null,
        loading: Boolean(live && (busy(live) || observedLoading)), observedOptionCount: optionCount };
      // Preserve startup focus/dispatch evidence and a rolling recent tail, so
      // a late blur or remount remains visible after a long stable wait.
      if (trace.length === limit) { trace.splice(8, 1); dropped++; }
      trace.push(entry);
    }
    const events = ['focus', 'focusin', 'blur', 'focusout'];
    const observe = event => {
      // Focus transfer destinations are represented only by safe structural
      // attributes. Capture no page-provided IDs, names or text.
      const live = resolveField(document, binding);
      if (event.target === initial || event.target === live || event.target === document.activeElement) sample(event.type, { element: live });
    };
    for (const type of events) document.addEventListener(type, observe, true);
    sample('before-focus');
    return { sample, result: () => ({ limit, dropped, trace }),
      stop: () => { for (const type of events) document.removeEventListener(type, observe, true); } };
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
    const diagnostics = queryDiagnostics(document, binding, element, query);
    let context; let options = []; let loading = false; let observed = false; let observationStarted = false;
    const deadline = Date.now() + (root.TreadwayChoiceBinding?.DEFAULT_WINDOW_MS || 15000);
    try {
      if (!continued) ownAction(element, () => {
        element.focus();
        diagnostics.sample('after-focus');
        if (element.localName === 'input') {
          nativeSetter(element).call(element, query);
          element.dispatchEvent(new view.InputEvent('input', { inputType: 'insertText', data: query, bubbles: true }));
        } else {
          element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, button: 0 }));
          element.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, button: 0 }));
          element.click();
        }
      });
      diagnostics.sample('after-dispatch');
      observationStarted = true;
      do {
        if (signal?.aborted) throw new Error('recording stopped');
        element = resolveField(document, binding);
        if (!element || !visible(element) || (humanEdits.get(element) || 0) !== editEpoch) throw new Error('field changed');
        context = controlledContext(element);
        loading = busy(element, context);
        options = (context?.list.options || []).filter(option => option.visible && !option.disabled)
          .map(option => ({ label: option.label, value: option.value ?? null, ref: option.ref }));
        diagnostics.sample('inspect', { element, optionCount: options.length, loading });
        if (options.length && !loading) break;
        if (element.getAttribute('aria-expanded') === 'false' && element.localName === 'input' && element.value !== query) throw new Error('query was not retained');
        await abortable(new Promise(resolve => setTimeout(resolve, 100)), signal);
      } while (Date.now() < deadline);
      const observation = { options, loading, context, kind: 'combobox', query, editEpoch,
        error: options.length ? '' : loading ? 'options still loading' : context ? 'no matching option' : 'no controlled list' };
      observed = true;
      if (retain && options.length && !loading) return observation;
      return observation;
    } catch (error) {
      if (error.message === 'query was not retained' || error.message === 'field changed') {
        diagnostics.sample('failed', { element }); error.queryDiagnostics = diagnostics.result();
      }
      throw error;
    } finally {
      diagnostics.stop();
      if (observationStarted && (!retain || !observed)) await closeChoices(document, binding, query, signal, editEpoch);
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
      if (reference) ownAction(element, () => root.TreadwayFormRuntime('select', { ref: reference.ref, value: chosen.value }));
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
        ownAction(element, () => target.click());
      }
      return { binding: bindingFor(element), expected };
    }
    const current = await observeChoices(document, plan.binding, plan.value, signal, { retain: true });
    let selectionAttempted = false;
    try {
      if (optionSet(current.options) !== optionSet(plan.observation.options)) throw new Error('options changed');
      const matches = current.options.filter(option => optionKey(option) === optionKey(chosen));
      if (matches.length !== 1) throw new Error('ambiguous option');
      const option = matches[0];
      const choice = root.TreadwayChoiceBinding.choiceContext(current.context.snapshot, current.context.fieldRef, option.ref);
      const hit = root.TreadwayFormRuntime('prepare', { ref: option.ref, choice: choice.binding });
      const target = document.elementFromPoint(hit.x, hit.y)?.closest('[role="option"]');
      if (!target) throw new Error('field changed');
      const ownedList = listElement(document, current.context);
      selectionAttempted = true;
      ownAction(target, () => target.click());
      await abortable(waitForSettle(document), signal);
      // A closing popup can stop mutating the DOM before its CSS exit
      // transition removes the modal hit target. Observe this exact owned
      // list until it stops being visible; never click through its backdrop
      // or assume that a fixed quiet period made the next field usable.
      const deadline = Date.now() + 1500;
      while (ownedList?.isConnected && visible(ownedList)) {
        assertContext(document);
        if (signal?.aborted) throw new Error('recording stopped');
        if (Date.now() >= deadline) throw new Error('choice popup did not close');
        await abortable(new Promise(resolve => setTimeout(resolve, 50)), signal);
      }
      return { binding: plan.binding, expected: option.label };
    } catch (error) {
      // Once dispatched, the option may be committed even if closing cannot
      // be confirmed. Search cleanup must not erase that selected value.
      if (!selectionAttempted) await closeChoices(document, plan.binding, current.query, signal, current.editEpoch);
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
  async function fillImplementation(document, { values = {}, profile, classify, decide, progress = () => {}, signal,
    boundValues = [], historyBindings = [], previousReport, awaitDependencies, maxFields = 1000 }) {
    const report = { filled: [], manual: [], decisions: [], batches: [], execution: { policy: 'human-order', observed: 0 } };
    const classifications = new Map();
    const hasProfile = profile?.context && (profile.context.description?.trim() ||
      ['facts', 'domains', 'preferences', 'circumstances', 'histories'].some(key => Object.keys(profile.context[key] || {}).length));
    const seen = new Set();
    const completed = [];
    const dataGap = reason => ['no persona value', 'unclassified', 'profile lookup needs a sourced query'].includes(reason);
    for (const previous of previousReport?.filled || []) {
      const entry = { ...previous, carriedForward: true };
      report.filled.push(entry);
      seen.add(bindingKey(previous.binding));
      completed.push({ binding: previous.binding, expected: previous.expectedValue, entry });
    }
    for (const previous of previousReport?.manual || []) {
      if (dataGap(previous.reason) || previous.reason === 'option match not confirmed' && previous.expectedValue === undefined &&
          boundValues.some(value => bindingKey(value.binding) === bindingKey(previous.binding))) continue;
      seen.add(bindingKey(previous.binding));
      report.manual.push({ ...previous, carriedForward: true });
      if (previous.required || previous.expectedValue !== undefined) report.blocked = { binding: previous.binding,
        reason: previous.required ? 'earlier required field unresolved' : 'earlier control outcome unresolved' };
    }
    for (let round = 0; round < maxFields; round += 1) {
      if (report.blocked) break;
      if (signal?.aborted) { report.interrupted = true; break; }
      assertContext(document);
      const elements = orderedFields(document).filter((element) => !seen.has(bindingKey(bindingFor(element))));
      if (!elements.length) break;
      const readingOrder = orderedFields(document, { includePopulated: true });
      const predecessor = readingOrder.slice(0, readingOrder.indexOf(elements[0])).find(element =>
        describeField(element).required && !isEmpty(element) && validationState(element, true)?.invalid);
      if (predecessor) {
        const field = describeField(predecessor), binding = bindingFor(predecessor);
        const reason = 'existing required field invalid';
        markManual(predecessor, reason);
        report.manual.push({ field, binding, selectors: selectorsFor(predecessor), required: true,
          groupLabel: field.groupLabel, reason, validation: validationState(predecessor, true) });
        report.blocked = { binding, reason: 'earlier required field unresolved' };
        break;
      }
      report.execution.observed += 1;
      let plans = elements.map((element, index) => {
        const binding = bindingFor(element);
        const field = describeField(element);
        const rule = Fields.ruleType(field);
        const direct = directFactType(field, values, rule);
        // Only the current control needs a new semantic binding. Existing
        // deductions can be consulted ahead without opening or typing widgets.
        const profileBinding = index === 0 && hasProfile || Object.keys(profile?.deductions || {}).length ?
          deductionBinding(document, binding, field) : null;
        const cached = profileBinding ? profile?.deductions?.[profileBinding.key] : null;
        const reusable = cached && cached.fieldBinding === profileBinding.fieldBinding ? cached : null;
        const known = classifications.get(JSON.stringify({ binding, field }));
        const linked = explicitValue(binding, direct || rule?.type, values, profile, boundValues, historyBindings);
        return { binding, field, key: 'f' + round + '_' + index,
          type: direct || linked?.type || rule?.type || known?.type || reusable?.type,
          by: direct ? 'persona key' : linked?.entry ? linked.entry.source : known ? 'jev' : rule?.by,
          ...(known || {}), ...(linked ? { valueEntry: linked.entry, historyBinding: linked.historyBinding } : {}),
          profileBinding, cached: reusable,
          unsupported: linked?.error || (element.type === 'file' ? 'file requires operator' : consent(element) ? 'operator decision' : null) };
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
        !plan.cached && !plan.valueEntry && !classifications.has(JSON.stringify({ binding: plan.binding, field: plan.field })) &&
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
          classifications.set(JSON.stringify({ binding: plan.binding, field: plan.field }), answers[plan.key] || {});
        }
        report.batches.push({ phase: 'classify', count: unknown.length, elapsedMs: Date.now() - started });
      }
      // A single generic education fact must not be copied into several distinct
      // history rows. Distinct row-specific keys are usable because their types
      // differ; matching the generic label is not a distinct record binding.
      const historyTypes = new Set(['institution', 'qualification_level', 'degree_title', 'classification', 'year_obtained']);
      const plannedTypes = new Map(plans.map(plan => [bindingKey(plan.binding), plan.type]));
      const observedTypes = [...document.querySelectorAll(CONTROL_SELECTOR)].filter(visible).map(element => {
        const field = describeField(element), rule = Fields.ruleType(field);
        return plannedTypes.get(bindingKey(bindingFor(element))) || directFactType(field, values, rule) ||
          classifiedTypeFor(element) || rule?.type;
      });
      for (const plan of plans) if (!plan.historyBinding && !plan.valueEntry && historyTypes.has(plan.type) &&
        observedTypes.filter(type => type === plan.type).length > 1) plan.unsupported = 'repeated history field needs an explicit persona binding';
      // Descriptor classification is observational and batched. Widget discovery
      // can focus/type and trigger dependencies, so only the current control is
      // inspected. Every completed action starts again from the live form.
      plans = plans.slice(0, 1);
      const selected = plans[0];
      seen.add(bindingKey(selected.binding));
      for (const plan of plans) plan.valueEntry ||= values[plan.type];
      const jobs = [];
      const jobFor = plan => ({ key: plan.key, field: plan.field, type: plan.type,
        ...(plan.mode === 'profile' ? { mode: 'profile' } : { intent: String(plan.value) }),
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
              plan.optionDecision = { action: 'select', confidence: answer.confidence, fit: answer.fit, label: selected.label,
                ...(plan.mode === 'profile' ? { mode: 'profile', personaRevision: profile.revision } : {}) };
              if (plan.mode === 'profile') plan.value = selected.label;
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
          !choiceControl(element) || element.multiple || Fields.SECRET_TYPES.has(plan.type)) continue;
        if (!plan.valueEntry) {
          if (!hasProfile || !decide) continue;
          plan.mode = 'profile';
          plan.type ||= Fields.normalise(plan.field.name || plan.field.groupLabel || plan.field.label).replace(/[^a-z0-9]+/g, '_').slice(0, 80) || 'profile_choice';
          plan.profileBinding = deductionBinding(document, plan.binding, plan.field);
          plan.cached = profile.deductions?.[plan.profileBinding.key];
          plan.value = plan.cached?.value || '';
          // Autocomplete needs a sourced query; selecting an arbitrary history
          // record or fabricating search text would mix persona records.
          if (element.localName === 'input' && !['radio', 'checkbox'].includes(element.type) && !plan.cached) {
            plan.choiceError = 'profile lookup needs a sourced query'; continue;
          }
        } else plan.value = Fields.formatValue(plan.type, plan.valueEntry.value, plan.field);
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
          plan.optionIndex = plan.mode === 'profile' ? null : exactOption(observation.options, plan.value, element, plan.type);
          if (plan.mode === 'profile' && plan.cached?.fieldBinding === plan.profileBinding.fieldBinding &&
            plan.cached.optionSignature === shortHash(optionSet(observation.options))) {
            const matches = observation.options.map((option, index) => ({ option, index })).filter(({ option }) =>
              option.label === plan.cached.selectedLabel && (option.value ?? null) === (plan.cached.selectedValue ?? null));
            if (matches.length === 1) {
              plan.optionIndex = matches[0].index;
              plan.optionDecision = { action: 'select', mode: 'profile', source: 'cache', personaRevision: profile.revision,
                confidence: plan.cached.confidence, fit: plan.cached.fit, label: matches[0].option.label };
              plan.value = matches[0].option.label;
            }
          }
          if (plan.optionIndex === null && decide &&
            !/password|secret|token|one.?time|\botp\b|api.?key|^card_|ppsn|email|phone|username/i.test(plan.type)) jobs.push(jobFor(plan));
        } catch (error) { plan.choiceError = error.message; if (error.queryDiagnostics) plan.queryDiagnostics = error.queryDiagnostics; }
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
          type: plan.type || null, by: plan.by || null, required: element ? describeField(element).required : plan.field.required, groupLabel: plan.field.groupLabel,
          ...(plan.historyBinding ? { historyBinding: plan.historyBinding } : {}), ...(plan.queryDiagnostics ? { queryDiagnostics: plan.queryDiagnostics } : {}) };
        if (element) rememberType(element, plan.type);
        if (plan.confidence !== undefined) entry.confidence = plan.confidence;
        if (plan.fit !== undefined) entry.fit = plan.fit;
        let reason = plan.unsupported || plan.choiceError || null;
        if (!reason) {
          if (!element || !visible(element)) reason = 'field changed';
          else if (element.localName === 'select' && element.multiple) reason = 'multiple selection requires human';
          else if (!plan.type) reason = 'unclassified';
          else if (Fields.SECRET_TYPES.has(plan.type) && (!plan.valueEntry?.credential ||
            plan.type === 'one_time_code' || (element.type !== 'password' &&
              !['new-password', 'current-password'].includes(plan.field.autocomplete)))) reason = 'secret';
          else if (!plan.valueEntry && plan.mode !== 'profile') reason = 'no persona value';
        }
        if (!reason && plan.type === 'new_password') {
          const existing = Array.from(document.querySelectorAll('input[type=password]')).filter(candidate =>
            candidate.form === element.form && visible(candidate) && candidate.value &&
            !currentPassword(describeField(candidate)) && Fields.ruleType(describeField(candidate))?.type !== 'one_time_code');
          if (existing.some(candidate => candidate.value !== plan.valueEntry.value)) reason = 'saved password differs from existing input';
        }
        if (!reason && !isEmpty(element)) continue;
        if (!reason && choiceControl(element) && (!plan.observation || plan.optionIndex === null || plan.optionIndex === undefined)) reason = 'no matching option';
        if (!reason) {
          plan.actionAttempted = true;
          const value = plan.mode === 'profile' ? plan.value : Fields.formatValue(plan.type, plan.valueEntry.value, plan.field);
          const source = plan.mode === 'profile' ? 'jev profile' : plan.valueEntry.source;
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
          } catch (error) { reason = error.message; if (error.queryDiagnostics) entry.queryDiagnostics = error.queryDiagnostics; }
          try { await waitForDependencies(document, resultBinding, plan.field, awaitDependencies, signal); }
          catch (error) { reason ||= error.message; plan.dependencyPending = true; }
          const live = resolveField(document, resultBinding);
          Object.assign(entry, { value, expectedValue: expected ?? null, observedValue: live ? fieldValue(live) : null,
            retained: live ? retained(live, expected) : null, validation: validationState(live, Fields.SECRET_TYPES.has(plan.type)),
            source });
          if (Fields.SECRET_TYPES.has(plan.type)) Object.assign(entry, { secret: true, secretReference: plan.valueEntry.secretReference });
          if (signal?.aborted) { report.interrupted = true; reason = 'recording stopped'; }
          else if (!reason && expected === null) reason = 'no matching option';
          else if (!reason && !live) reason = 'field changed';
          else if (!reason && !entry.retained) reason = 'did not stick';
          else if (!reason && entry.validation?.invalid) reason = 'validation error';
          if (!reason) {
            rememberType(live, plan.type);
            const filled = Object.assign(entry, { selectors: selectorsFor(live), field: describeField(live), binding: resultBinding, value,
              expectedValue: expected, observedValue: fieldValue(live), source });
            if (plan.optionDecision) filled.optionDecision = plan.optionDecision;
            if (plan.mode === 'profile' && plan.optionDecision?.source !== 'cache') {
              const selected = plan.observation.options[plan.optionIndex];
              filled.profileDeduction = { ...plan.profileBinding, type: plan.type, value: selected.label,
                field: plan.field, binding: resultBinding, selectedLabel: selected.label, selectedValue: selected.value ?? null,
                optionSignature: shortHash(optionSet(plan.observation.options)),
                confidence: plan.optionDecision.confidence, fit: plan.optionDecision.fit };
            }
            if (Fields.SECRET_TYPES.has(plan.type)) Object.assign(filled, {
              secret: true, secretReference: plan.valueEntry.secretReference });
            report.filled.push(filled);
            completed.push({ binding: resultBinding, expected, entry: filled });
            continue;
          }
        }
        const current = resolveField(document, plan.binding);
        if (current) markManual(current, reason);
        report.manual.push(Object.assign(entry, { reason }));
        if (entry.required || plan.dependencyPending || plan.actionAttempted) {
          report.blocked = { binding: plan.binding, reason: plan.dependencyPending ? 'earlier form update unresolved' :
            plan.actionAttempted ? 'earlier control outcome unresolved' : 'earlier required field unresolved' };
          break;
        }
      }
      if (report.blocked || report.interrupted) break;
      if (round + 1 === maxFields && orderedFields(document).some(element => !seen.has(bindingKey(bindingFor(element))))) {
        report.execution.limitReached = true;
        report.interrupted = true;
        report.blocked = { reason: 'form traversal budget reached' };
      }
    }
    // A later field can reset an earlier one. Verify the final live form too.
    for (const item of completed) {
      const live = resolveField(document, item.binding);
      const valueRetained = live ? retained(live, item.expected) : null;
      const validation = validationState(live, Fields.SECRET_TYPES.has(item.entry.type));
      Object.assign(item.entry, { retained: valueRetained, validation, observedValue: live ? fieldValue(live) : null });
      if (!valueRetained || validation?.invalid) {
        const reason = !live ? 'field changed' : valueRetained ? 'validation error' : 'did not stick';
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
    // Historical successes remain evidence, but a new persona revision must not
    // acquire the previous pass's deductions as if they were freshly inferred.
    report.deductions = report.filled.filter(entry => entry.profileDeduction && !entry.carriedForward).map(entry => entry.profileDeduction);
    progress('done', report.filled.length);
    return report;
  }

  const api = { orderedFields, describeField, selectorsFor, actionTarget, fillableFields, setFieldValue, waitForSettle, fillAll,
    classifiedTypeFor, bindingFor, resolveField, credentialNeeds, noteHumanEdit, isOwnAction, isEmpty, fieldValue, MANUAL_ATTRIBUTE };
  root.TreadwayPageFill = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
