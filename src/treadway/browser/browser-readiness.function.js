(function waitForBrowserReadiness(options) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer;
    function inspect() {
      const unmet = [];
      if (document.readyState === "loading") unmet.push("document_loading");
      for (const selector of options.selectors || []) {
        let element;
        try { element = document.querySelector(selector); }
        catch (_) { unmet.push("invalid_selector"); continue; }
        if (!element) { unmet.push("element_missing"); continue; }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.display === "none" ||
            style.visibility === "hidden" || style.visibility === "collapse" ||
            Number(style.opacity) === 0) unmet.push("element_hidden");
        if (element.disabled || element.readOnly || element.closest('[inert]') ||
            element.getAttribute("aria-disabled") === "true") unmet.push("element_disabled");
      }
      if (options.predicate) {
        try {
          if (new Function("return (" + options.predicate + ")")() !== true)
            unmet.push("application_not_ready");
        } catch (_) { unmet.push("application_condition_error"); }
      }
      const ready = unmet.length === 0;
      if (ready || Date.now() - started >= options.timeoutMs) {
        clearInterval(timer);
        resolve({ ready, unmet: [...new Set(unmet)], elapsedMs: Date.now() - started });
      }
    }
    // Poll conditions, rather than assume that sleeping makes the next action
    // safe. CSS transitions and app state may change without DOM mutations.
    timer = setInterval(inspect, 50);
    inspect();
  });
})
