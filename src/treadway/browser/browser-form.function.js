(function formRuntime(command, args = {}) {
  // Injected in one explicit document. No React internals, DOM attribute writes, or
  // passive validation triggers. References expire when their node is replaced.
  const KEY = '__treadwayFormV3';
  const clean = x => String(x || '').replace(/\s+/g, ' ').trim();
  const visible = e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const disabled = e => !!e.disabled || e.matches(':disabled') ||
    e.getAttribute('aria-disabled') === 'true' || !!e.closest('[inert]');
  const texts = ids => (ids || '').split(/\s+/).map(id => document.getElementById(id))
    .filter(Boolean).map(e => clean(e.textContent)).filter(Boolean);
  const label = e => clean(e.getAttribute('aria-label')) ||
    texts(e.getAttribute('aria-labelledby')).join(' ') ||
    [...(e.labels || [])].map(l => clean(l.textContent)).join(' ') ||
    (e.isContentEditable ? clean(e.getAttribute('aria-placeholder') || e.getAttribute('data-placeholder')) : clean(e.textContent)) ||
    (['submit', 'button', 'reset'].includes(e.type) ? e.value : '') || e.title || '';
  const signature = e => [e.tagName, e.id, e.getAttribute('name'), e.getAttribute('role'), e.type, label(e)];
  let state = window[KEY];
  if (!state) state = window[KEY] = { documentId: crypto.randomUUID(), next: 0, nodes: new Map(), ids: new WeakMap(), events: [] };
  if (state.url !== location.href) { state.url=location.href; state.locationId=crypto.randomUUID(); }
  const publicURL = x => { try { const u=new URL(x,location.href); return u.origin+u.pathname; } catch { return null; } };
  const ref = e => {
    const previous=state.nodes.get(state.ids.get(e));
    if (!previous || JSON.stringify(previous.signature)!==JSON.stringify(signature(e))) {
      const id = `${state.documentId}:${++state.next}`;
      state.ids.set(e, id); state.nodes.set(id, { node: e, signature: signature(e) });
    }
    return state.ids.get(e);
  };
  const resolve = id => {
    const entry = state.nodes.get(id);
    if (!entry || !entry.node.isConnected || JSON.stringify(entry.signature) !== JSON.stringify(signature(entry.node))) {
      throw new Error('stale_or_unknown_reference: inspect again');
    }
    return entry.node;
  };
  const secret = e => ['password', 'hidden'].includes(e.type) ||
    /password|one-time-code|cc-/.test(e.autocomplete || '') || /password|secret|token|api.?key/i.test((e.name||'')+' '+(e.id||''));
  const value = e => secret(e) ? { redacted: true } : {
    value: e.isContentEditable ? e.innerText : typeof e.value === 'string' ? e.value : null,
    checked: ['checkbox', 'radio'].includes(e.type) ? e.checked : null,
    display: e.getAttribute('role') === 'combobox' ? clean(e.textContent) : null,
  };
  const errors = root => [...root.querySelectorAll('[role="alert"], [aria-live="assertive"], .MuiFormHelperText-root.Mui-error')]
    .filter(visible).map(e => ({ ref: ref(e), text: clean(e.textContent),
      source: e.matches('.MuiFormHelperText-root.Mui-error') ? 'component_error_marker' : 'unclassified_live_feedback' })).filter(x => x.text);
  const dialogs = () => [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
    .filter(visible).map(e => ({ ref: ref(e), label: label(e), text: clean(e.textContent).slice(0, 1200), modal: e.getAttribute('aria-modal') === 'true' || e.matches('dialog:modal') }));
  const choiceVisible = e => visible(e) && !e.closest('[aria-hidden="true"]');
  const choiceDisabled = e => disabled(e) || !!e.closest('[aria-disabled="true"]');
  const controlTargets = (field, lists) => [...new Set(['aria-controls','aria-owns']
    .flatMap(attribute => (field.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)))].map(controlId => {
    // ID lookup must observe duplicates; getElementById would silently choose one.
    const matches = [...document.querySelectorAll('[id]')].filter(e => e.id === controlId);
    const container = matches.length === 1 ? matches[0] : null;
    return {controlId,matchCount:matches.length,containerRef:container ? ref(container) : null,
      disabled:container ? choiceDisabled(container) : null,
      listboxRefs:container ? lists.filter(e => e === container || container.contains(e)).map(ref) : []};
  });

  if (command === 'inspect') {
    for (const [id,entry] of state.nodes) if(!entry.node.isConnected) state.nodes.delete(id);
    const roots = document.querySelectorAll(args.scope || 'body');
    if (roots.length !== 1) throw new Error('scope_must_match_exactly_one_element');
    const root = roots[0];
    const controls = new Set(root.querySelectorAll('input,textarea,select,[role="combobox"],[role="radiogroup"],[role="checkbox"],[role="switch"],[contenteditable="true"],[contenteditable="plaintext-only"]'));
    if (root.matches('form')) for (const e of root.elements) controls.add(e);
    const fields = [...controls].filter(e => !['submit', 'button', 'reset', 'image'].includes(e.type)).map(e => ({
      ref: ref(e), id: e.id || null, name: e.getAttribute('name'), tag: e.tagName.toLowerCase(), type: e.type || null,
      contenteditable: e.isContentEditable,
      controls: e.getAttribute('aria-controls'), owns: e.getAttribute('aria-owns'), expanded: e.getAttribute('aria-expanded'),
      role: e.getAttribute('role'), label: label(e), visible: visible(e), disabled: disabled(e), readonly: !!e.readOnly || e.getAttribute('aria-readonly') === 'true',
      form: e.form ? ref(e.form) : null, group: clean(e.closest('fieldset')?.querySelector('legend')?.textContent),
      required: !!e.required || e.getAttribute('aria-required') === 'true',
      requirementHints: label(e).includes('*') ? [{source:'label_marker',meaning:'possibly_required_not_confirmed'}] : [],
      constraints: Object.fromEntries(['min','max','minlength','maxlength','pattern','accept','multiple','inputmode','autocomplete'].map(k => [k,e.getAttribute(k)]).filter(([,v]) => v !== null)),
      validity: e.validity ? Object.fromEntries(['valid','valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError'].map(k => [k, e.validity[k]])) : null,
      validationMessage: e.validationMessage || null, ariaInvalid: e.getAttribute('aria-invalid'),
      descriptions: texts(e.getAttribute('aria-describedby')), errors: texts(e.getAttribute('aria-errormessage')),
      ...value(e),
      choices: e.tagName === 'SELECT' ? [...e.options].map(o => ({ value: o.value, label: clean(o.label), selected: o.selected, disabled: o.disabled || !!o.closest('optgroup[disabled]') })) : null,
    }));
    // Actions are deliberately page-wide and FIRST in the returned object: form
    // attribute buttons, wizard navigation and secondary saves may live outside root.
    const actions = [...document.querySelectorAll('button,input[type="submit"],input[type="button"],input[type="reset"],input[type="image"],[role="button"],a[href],tr[tabindex="0"],[role="row"][tabindex="0"]')].map(e => ({
      ref: ref(e), label: label(e), tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), type: e.type || null,
      visible: visible(e), disabled: disabled(e), inScope: root.contains(e), form: e.form ? ref(e.form) : null,
      associatedWithScope: root.contains(e) || e.form===root,
      href: e.hasAttribute('href') ? publicURL(e.getAttribute('href')) : null, formAction: e.hasAttribute('formaction') ? publicURL(e.getAttribute('formaction')) : null, formMethod: e.getAttribute('formmethod'), formNoValidate: !!e.formNoValidate,
      controls:e.getAttribute('aria-controls'), expanded:e.getAttribute('aria-expanded'),
      selected:e.getAttribute('aria-selected'), tabindex:e.getAttribute('tabindex'),
      behaviour: 'unverified',
    })).sort((a,b)=>Number(b.associatedWithScope)-Number(a.associatedWithScope)||Number(!!b.form)-Number(!!a.form)||Number(b.visible)-Number(a.visible)||Number(b.tag!=='a')-Number(a.tag!=='a'));
    const listNodes = [...document.querySelectorAll('[role="listbox"]')].filter(choiceVisible);
    for (const field of fields) if (field.role === 'combobox') {
      const node = resolve(field.ref);
      field.controlledElements = controlTargets(node,listNodes);
      field.choiceUsable = choiceVisible(node) && !choiceDisabled(node) && !field.readonly;
    }
    const listboxes = listNodes.map(e => ({
      ref: ref(e), id: e.id || null, disabled:choiceDisabled(e),
      controllers:fields.flatMap(f => (f.controlledElements || []).filter(c => c.listboxRefs.includes(ref(e)))
        .map(c => ({fieldRef:f.ref,controlId:c.controlId,containerRef:c.containerRef}))),
      options: [...e.querySelectorAll('[role="option"]')].filter(o => o.closest('[role="listbox"]') === e)
        .map(o => ({ ref: ref(o), label: label(o), visible:choiceVisible(o), disabled:choiceDisabled(o), selected: o.getAttribute('aria-selected') }))
    }));
    return { actions, dialogs: dialogs(), listboxes, observed: true, documentId: state.documentId,
      observedAt: new Date().toISOString(), url: publicURL(location.href), locationId:state.locationId, scope: args.scope || 'body',
      step: [...root.querySelectorAll('[aria-current="step"], [role="tab"][aria-selected="true"], .MuiStep-root.Mui-active')].map(e => ({ ref: ref(e), label: label(e) })),
      headings: [...root.querySelectorAll('h1,h2,h3')].filter(visible).map(e => clean(e.textContent)),
      fields, errors: errors(root), readyState: document.readyState,
      frames: [...document.querySelectorAll('iframe')].map(e=>({ref:ref(e),id:e.id||null,name:e.name||null,title:e.title||null,src:publicURL(e.src),visible:visible(e)})),
      limitations: ['one_explicit_document', 'custom_constraints_may_be_unobserved', 'observed_values_do_not_prove_persistence'],
    };
  }
  if (command === 'form_binding') {
    const forms=document.querySelectorAll(args.contract.selector);
    if(forms.length!==1||forms[0].tagName!=='FORM')throw new Error('one_native_form_required');
    const form=forms[0],action=resolve(args.actionRef);
    const url=new URL(form.action,location.href),expected=new URL(args.contract.action);
    const overrides=[...form.elements].filter(e=>e.name==='_method');
    const expectedOverride=args.contract.methodOverride;
    return {formRef:ref(form),actionRef:ref(action),actionURL:publicURL(form.action),method:form.method,
      targetMatches:url.origin===location.origin&&url.href===expected.href,
      methodMatches:form.method===args.contract.method,
      overrideMatches:expectedOverride===null?overrides.length===0:
        overrides.length===1&&!disabled(overrides[0])&&overrides[0].value===expectedOverride,
      fieldsAssociated:args.fieldRefs.every(id=>{const e=resolve(id);return (e.form||e.closest('form'))===form;}),
      submitAssociated:action.form===form&&action.type==='submit',
      submitOverridesAbsent:!action.hasAttribute('formaction')&&!action.hasAttribute('formmethod')};
  }
  if (command === 'scroll') {
    const matches=document.querySelectorAll(args.selector);
    if(matches.length!==1)throw new Error('scroll_target_missing_or_ambiguous');
    matches[0].scrollIntoView({block:'center',inline:'nearest'});
    return {scrolled:true};
  }
  if (command === 'locate') {
    if (typeof args.selector !== 'string' || !args.selector.trim()) throw new Error('explicit_selector_required');
    const matches = document.querySelectorAll(args.selector);
    if (matches.length !== 1) return { matchCount: matches.length };
    return { ref: ref(matches[0]), documentId: state.documentId, locationId: state.locationId };
  }
  if (command === 'arm') {
    if (!state.armed) {
      for (const type of ['invalid', 'submit', 'reset']) document.addEventListener(type, event => {
        state.events.push({ type, ref: ref(event.target), at: new Date().toISOString() });
        if (state.events.length > 500) { state.events.shift(); state.truncated = true; }
      }, true);
      state.armed = true;
    }
    state.events = []; state.truncated = false;
    return { armed: true, documentId: state.documentId };
  }
  if (command === 'events') return { documentId: state.documentId, events: state.events, truncated: !!state.truncated };
  if (command === 'prepare') {
    const e = resolve(args.ref);
    if (args.choice) {
      const c=args.choice, field=resolve(c.fieldRef), list=resolve(c.listboxRef);
      const lists=[...document.querySelectorAll('[role="listbox"]')].filter(choiceVisible);
      const targets=controlTargets(field,lists);
      const relations=targets.flatMap(t=>t.listboxRefs.map(listboxRef=>({...t,listboxRef})));
      if (targets.some(t=>t.matchCount!==1) || relations.length!==1 ||
          relations[0].containerRef!==c.containerRef || relations[0].controlId!==c.controlId ||
          relations[0].listboxRef!==c.listboxRef || e.closest('[role="listbox"]')!==list)
        throw new Error('choice_association_changed_inspect_again');
      if (field.getAttribute('role')!=='combobox' || !choiceVisible(field) || choiceDisabled(field) ||
          field.readOnly || field.getAttribute('aria-readonly')==='true' || relations[0].disabled ||
          choiceDisabled(list) || !choiceVisible(e) || choiceDisabled(e)) throw new Error('choice_not_usable');
    }
    if (disabled(e) || e.readOnly || e.getAttribute('aria-readonly') === 'true') throw new Error('control_disabled_or_readonly');
    let hit = e;
    if (!visible(e) && ['checkbox','radio'].includes(e.type)) hit = [...(e.labels || [])].find(visible);
    if (!hit || !visible(hit)) throw new Error('control_not_visible');
    hit.scrollIntoView({ block: 'center', inline: 'center' });
    const r = hit.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
    const cover = document.elementFromPoint(x, y);
    if (!cover || !(hit === cover || hit.contains(cover) || e === cover)) throw new Error('control_occluded');
    return { x, y, tag: e.tagName.toLowerCase(), type: e.type || '', role: e.getAttribute('role'), ...value(e) };
  }
  if (command === 'read') return { present: true, ...value(resolve(args.ref)) };
  if (command === 'selection_bound') {
    const e = resolve(args.ref), selection = getSelection();
    return !!selection && e.isContentEditable &&
      !!selection.anchorNode && !!selection.focusNode &&
      e.contains(selection.anchorNode) && e.contains(selection.focusNode);
  }
  if (command === 'frame_info' || command === 'frame_bounds' || command === 'frame_hit') {
    const e = resolve(args.ref);
    if (e.tagName !== 'IFRAME' || !e.contentDocument || e.contentWindow.location.origin !== location.origin) throw new Error('accessible_same_origin_iframe_required');
    if (command === 'frame_info') return {sameOrigin:true};
    if (!visible(e)) throw new Error('frame_not_visible');
    for (let node=e;node;node=node.parentElement) if(getComputedStyle(node).transform!=='none') throw new Error('transformed_frame_not_calibrated');
    if (command === 'frame_bounds') {
      e.scrollIntoView({block:'center',inline:'center'});
      const r=e.getBoundingClientRect();
      if(Math.abs(r.width-e.offsetWidth)>1||Math.abs(r.height-e.offsetHeight)>1)throw new Error('scaled_frame_not_calibrated');
      return {left:r.x+e.clientLeft,top:r.y+e.clientTop,width:e.clientWidth,height:e.clientHeight};
    }
    if(document.elementFromPoint(args.x,args.y)!==e)throw new Error('frame_occluded');
    return {clear:true};
  }
  if (command === 'select') {
    const e = resolve(args.ref);
    if (e.tagName !== 'SELECT' || e.multiple || disabled(e)) throw new Error('unsupported_select');
    const choices = [...e.options].filter(o => o.value === args.value);
    if (choices.length !== 1 || choices[0].disabled || choices[0].closest('optgroup[disabled]')) throw new Error('choice_absent_ambiguous_or_disabled');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,args.value);
    e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    e.blur(); return { applied: true };
  }
  throw new Error('unknown_form_runtime_command');
})
