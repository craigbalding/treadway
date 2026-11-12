(function ({ selector, value }) {
  if (Object.hasOwn(arguments[0], 'origin') && location.origin !== arguments[0].origin) return { ok: false };
  // Return only a boolean receipt: never return a credential or DOM content.
  const element = document.querySelector(selector);
  if (!element || element.disabled || element.readOnly ||
      element.closest('[inert]') || element.matches(':disabled') ||
      element.getAttribute('aria-disabled') === 'true') return { ok: false };
  const view = element.ownerDocument.defaultView;
  const prototype = element instanceof view.HTMLInputElement
    ? view.HTMLInputElement.prototype
    : element instanceof view.HTMLTextAreaElement
      ? view.HTMLTextAreaElement.prototype : null;
  if (!prototype) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  element.focus();
  // The native setter replaces prefilled/autofilled text and notifies common
  // controlled-input frameworks without assigning to their instance tracker.
  setter.call(element, value);
  element.dispatchEvent(new view.Event('input', { bubbles: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true }));
  return { ok: element.value === value };
})
