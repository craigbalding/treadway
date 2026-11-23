// Page-side helpers: describe fields, compute selector candidates and fill
// forms through the native value setter so framework state sees the change.
// Requires TreadwayFields. Runs as a content script and in browser tests.
(function (root) {
  'use strict';

  const Fields = root.TreadwayFields;
  const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
  const MANUAL_ATTRIBUTE = 'data-treadway-manual';
  const classifiedFields = new WeakMap();
  const CONTROL_SELECTOR = 'input, textarea, select, [role="combobox"]';

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
      groupLabel: element.closest && element.closest('fieldset') ? text(element.closest('fieldset').querySelector('legend')?.textContent) : '',
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
    if (element.localName === 'select') return element.selectedIndex < 0 || !element.options[element.selectedIndex].value;
    if (element.getAttribute('role') === 'combobox' && element.localName !== 'input') {
      const backing = element.parentElement?.querySelector('input[aria-hidden="true"]');
      if (backing) return !backing.value;
      return !fieldValue(element) || /^(--\s*)?(please\s+)?(select|choose)(\s+.*|\s*--)?$/i.test(fieldValue(element));
    }
    return element.value === '';
  }
  function fieldValue(element) {
    return 'value' in element ? element.value : text(element.textContent).replace(/[\u200b\ufeff]/g, '').trim();
  }

  function fillableFields(document) {
    return Array.from(document.querySelectorAll(CONTROL_SELECTOR)).filter((element) => {
      if (element.localName === 'input' && SKIPPED_INPUT_TYPES.has((element.getAttribute('type') || 'text').toLowerCase())) return false;
      return visible(element) && isEmpty(element);
    });
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

  function stuck(element, expected) {
    return element.isConnected && fieldValue(element) === expected && element.getAttribute('aria-invalid') !== 'true';
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
  async function setControlValue(document, binding, value, signal) {
    let element = resolveField(document, binding);
    if (!element || !visible(element)) throw new Error('field changed');
    if (element.getAttribute('role') !== 'combobox' || element.localName === 'select') return setFieldValue(element, value);
    const view = document.defaultView;
    element.focus();
    if (element.localName === 'input') {
      nativeSetter(element).call(element, String(value));
      element.dispatchEvent(new view.Event('input', { bubbles: true }));
    } else {
      element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await abortable(waitForSettle(document), signal);
      element = resolveField(document, binding);
      if (signal?.aborted) throw new Error('recording stopped');
      if (!element) throw new Error('field changed');
      if (!controlledContext(element) && element.getAttribute('aria-expanded') !== 'true') element.click();
    }
    const deadline = Date.now() + 2500;
    let matches = [];
    let list;
    while (Date.now() < deadline && !signal?.aborted) {
      await abortable(waitForSettle(document), signal);
      element = resolveField(document, binding);
      if (!element || !visible(element)) throw new Error('field changed');
      list = controlledContext(element);
      if (list) {
        matches = list.list.options.filter(option => option.visible && !option.disabled &&
          option.label.toLowerCase() === String(value).trim().toLowerCase());
        if (matches.length) break;
      }
    }
    if (signal?.aborted) throw new Error('recording stopped');
    if (matches.length > 1) throw new Error('ambiguous option');
    if (!matches.length) throw new Error(list ? 'no matching option' : 'no controlled list');
    const option = matches[0];
    const expected = option.label;
    // Reuse the same library relationship, usability and hit-target checks
    // as ControlledChoice/FormAssessor. Only event dispatch is extension-local.
    const choice = root.TreadwayChoiceBinding.choiceContext(list.snapshot, list.fieldRef, option.ref);
    const hit = root.TreadwayFormRuntime('prepare', { ref: option.ref, choice: choice.binding });
    const target = document.elementFromPoint(hit.x, hit.y)?.closest('[role="option"]');
    if (!target) throw new Error('field changed');
    target.click();
    await abortable(waitForSettle(document), signal);
    return expected;
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
  async function fillAll(document, { values, classify, rounds, signal }) {
    const report = { filled: [], manual: [] };
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
        return { binding, field, key: 'f' + round + '_' + index, type: rule && rule.type, by: rule && rule.by };
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
      const unknown = plans.filter((plan) => !plan.type || (!values[plan.type] && !plan.type.startsWith('previous_')));
      if (unknown.length && classify) {
        let answers = {};
        try {
          answers = await abortable(classify(unknown.map((plan) => Object.assign({ key: plan.key }, plan.field))), signal) || {};
        } catch (error) {
          report.classifyError = error.message;
        }
        for (const plan of unknown) {
          if (answers[plan.key]) Object.assign(plan, { type: answers[plan.key].type, by: 'jev', confidence: answers[plan.key].confidence });
        }
      }
      for (const plan of plans) {
        if (signal?.aborted) { report.interrupted = true; break; }
        const element = resolveField(document, plan.binding);
        const entry = { selectors: element ? selectorsFor(element) : {}, field: plan.field, binding: plan.binding,
          type: plan.type || null, by: plan.by || null };
        if (element) rememberType(element, plan.type);
        if (plan.confidence !== undefined) entry.confidence = plan.confidence;
        let reason = null;
        if (!element || !visible(element)) reason = 'field changed';
        else if (element.localName === 'select' && element.multiple) reason = 'multiple selection requires human';
        else if (!plan.type) reason = 'unclassified';
        else if (Fields.SECRET_TYPES.has(plan.type) && (!values[plan.type]?.credential ||
          plan.type === 'one_time_code' || (element.type !== 'password' &&
            !['new-password', 'current-password'].includes(plan.field.autocomplete)))) reason = 'secret';
        else if (!values[plan.type]) reason = 'no persona value';
        if (!reason && plan.type === 'new_password') {
          const existing = Array.from(document.querySelectorAll('input[type=password]')).filter(candidate =>
            candidate.form === element.form && visible(candidate) && candidate.value &&
            !currentPassword(describeField(candidate)) && Fields.ruleType(describeField(candidate))?.type !== 'one_time_code');
          if (existing.some(candidate => candidate.value !== values[plan.type].value)) reason = 'saved password differs from existing input';
        }
        if (!reason && !isEmpty(element)) continue;
        if (!reason) {
          const value = Fields.formatValue(plan.type, values[plan.type].value, plan.field);
          let expected;
          try { expected = await setControlValue(document, plan.binding, value, signal); } catch (error) { reason = error.message; }
          await abortable(waitForSettle(document), signal);
          const live = resolveField(document, plan.binding);
          if (signal?.aborted) { report.interrupted = true; reason = 'recording stopped'; }
          else if (!reason && expected === null) reason = 'no matching option';
          else if (!reason && (!live || !stuck(live, expected))) reason = 'did not stick';
          if (!reason) {
            rememberType(live, plan.type);
            const filled = Object.assign(entry, { selectors: selectorsFor(live), value,
              expectedValue: expected, observedValue: fieldValue(live), source: values[plan.type].source });
            if (Fields.SECRET_TYPES.has(plan.type)) Object.assign(filled, {
              secret: true, secretReference: values[plan.type].secretReference });
            report.filled.push(filled);
            completed.push({ binding: plan.binding, expected, entry: filled });
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
      if (!live || !stuck(live, item.expected)) {
        report.filled = report.filled.filter((entry) => entry !== item.entry);
        if (live) markManual(live, 'did not stick');
        report.manual.push(Object.assign({}, item.entry, { reason: 'did not stick', observedValue: live ? fieldValue(live) : null }));
      }
    }
    // Later React remounts can remove a previous manual highlight.
    for (const entry of report.manual) {
      const live = resolveField(document, entry.binding);
      if (live) markManual(live, entry.reason);
    }
    return report;
  }

  const api = { describeField, selectorsFor, actionTarget, fillableFields, setFieldValue, waitForSettle, fillAll,
    classifiedTypeFor, bindingFor, resolveField, credentialNeeds, MANUAL_ATTRIBUTE };
  root.TreadwayPageFill = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
