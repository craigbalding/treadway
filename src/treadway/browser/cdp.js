#!/usr/bin/env node
// CDP utility layer for webapp exploration.
// Programmatic API; all connections require an explicit page target.
// Sits on top of cdp-proxy.js (explicit local browser or HTTP proxy transport).
//
// Requires explicit host and port for every connection.
// No default browser — every connection must specify which Chrome instance.

const fs = require("fs");
const path = require("path");
const { createCdpProxy } = require("./cdp-proxy");

// ---------------------------------------------------------------------------
// CDP client wrapper (command/event multiplexer over raw WebSocket)
// ---------------------------------------------------------------------------

function makeCdpClient(ws, { commandTimeoutMs = 30000 } = {}) {
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error("commandTimeoutMs must be a positive integer");
  }
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const eventListeners = new Map();
  const allSessionListeners = new Map();
  const sessionStates = new Map();
  const eventWaiters = new Set();

  function settle(id, error, result) {
    const item = pending.get(id);
    if (!item) return; // A late reply cannot resolve a different command.
    clearTimeout(item.timer);
    pending.delete(id);
    if (error) item.reject(error);
    else item.resolve(result);
  }

  function disconnect(message) {
    closed = true;
    for(const state of sessionStates.values())state.active=false;
    sessionStates.clear();
    for (const id of pending.keys()) settle(id, new Error(message));
    for (const cancel of [...eventWaiters]) cancel(new Error(message));
    eventListeners.clear();
    allSessionListeners.clear();
  }

  ws.on("close", () => disconnect("CDP socket closed before response; command outcome unknown"));
  ws.on("error", () => disconnect("CDP socket failed before response; command outcome unknown"));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
      if (!msg || typeof msg !== "object" || Array.isArray(msg) ||
          !(Number.isSafeInteger(msg.id) || typeof msg.method === "string") ||
          (Number.isSafeInteger(msg.id) && !(Object.hasOwn(msg, "result") || msg.error))) throw new Error();
    } catch {
      disconnect("Malformed CDP message; command outcome unknown");
      if (ws.terminate) ws.terminate(); else ws.close();
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      if ((msg.sessionId || null) !== pending.get(msg.id).sessionId) {
        settle(msg.id, new Error('CDP response session differs; command outcome unknown'));
        return;
      }
      if (msg.error) {
        settle(msg.id, new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      } else {
        settle(msg.id, null, msg.result);
      }
    }
    const eventKey = JSON.stringify([msg.sessionId || null, msg.method]);
    if (msg.method && allSessionListeners.has(msg.method)) {
      for (const handler of [...allSessionListeners.get(msg.method)]) {
        try { handler(msg.params, msg.sessionId || null); }
        catch { disconnect('Invalid CDP event; command outcome unknown'); if(ws.terminate)ws.terminate();else ws.close();return; }
      }
    }
    if (msg.method && eventListeners.has(eventKey)) {
      for (const handler of [...eventListeners.get(eventKey)]) {
        try { handler(msg.params); }
        catch {
          disconnect("Invalid CDP event; command outcome unknown");
          if (ws.terminate) ws.terminate(); else ws.close();
          return;
        }
      }
    }
  });

  return {
    // A deadline stops waiting; it does NOT cancel the browser command or prove
    // that a state-changing action failed. Observe its effect before any retry.
    send(method, params = {}, { timeoutMs = commandTimeoutMs, sessionId = null } = {}) {
      return new Promise((resolve, reject) => {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          reject(new Error("timeoutMs must be a positive integer"));
          return;
        }
        if (closed) {
          reject(new Error("CDP socket is closed; command not sent"));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          const error = new Error(`CDP ${method} timed out after ${timeoutMs}ms; command outcome unknown`);
          Object.assign(error, { code: "CDP_COMMAND_TIMEOUT", method, commandId: id, timeoutMs, outcome: "unknown" });
          settle(id, error);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, sessionId });
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) }), (error) => {
            if (error) settle(id, new Error("CDP send failed before response; command outcome unknown"));
          });
        } catch (error) {
          settle(id, error);
        }
      });
    },
    on(eventName, handler, sessionId = null) {
      eventName = JSON.stringify([sessionId, eventName]);
      if (!eventListeners.has(eventName)) eventListeners.set(eventName, []);
      eventListeners.get(eventName).push(handler);
    },
    onAll(eventName, handler) {
      if(!allSessionListeners.has(eventName))allSessionListeners.set(eventName,[]);
      allSessionListeners.get(eventName).push(handler);
      return ()=>{
        const handlers=allSessionListeners.get(eventName)||[];
        const index=handlers.indexOf(handler);if(index>=0)handlers.splice(index,1);
      };
    },
    off(eventName, handler, sessionId = null) {
      eventName = JSON.stringify([sessionId, eventName]);
      const handlers = eventListeners.get(eventName) || [];
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    once(eventName, { timeoutMs = commandTimeoutMs, sessionId = null } = {}) {
      let cancel;
      const promise = new Promise((resolve, reject) => {
        if (closed) { reject(new Error("CDP socket is closed")); return; }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { reject(new Error("timeoutMs must be a positive integer")); return; }
        const finish = (error, params) => {
          clearTimeout(timer);
          this.off(eventName, handler, sessionId);
          eventWaiters.delete(cancel);
          if (error) reject(error); else resolve(params);
        };
        const handler = params => finish(null, params);
        cancel = error => finish(error || new Error("CDP event wait cancelled"));
        cancel.sessionId = sessionId;
        const timer = setTimeout(() => cancel(new Error(`CDP event ${eventName} deadline; outcome unknown`)), timeoutMs);
        eventWaiters.add(cancel);
        this.on(eventName, handler, sessionId);
      });
      promise.cancel = () => cancel?.();
      return promise;
    },
    session(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Explicit CDP sessionId required');
      if(!sessionStates.has(sessionId))sessionStates.set(sessionId,{active:!closed});
      const state=sessionStates.get(sessionId);
      const requireActive=()=>{if(!state.active)throw new Error('CDP session detached; command not sent');};
      return {
        send: (method, params = {}, options = {}) => {if(!state.active)return Promise.reject(new Error('CDP session detached; command not sent'));return this.send(method, params, {...options, sessionId});},
        on: (event, handler) => {requireActive();return this.on(event, handler, sessionId);},
        off: (event, handler) => this.off(event, handler, sessionId),
        once: (event, options = {}) => {requireActive();return this.once(event, {...options, sessionId});},
      };
    },
    removeSession(sessionId) {
      if(typeof sessionId!=='string'||!sessionId)throw new Error('Explicit CDP sessionId required');
      const state=sessionStates.get(sessionId);if(state)state.active=false;
      sessionStates.delete(sessionId);
      for(const [id,item] of pending)if(item.sessionId===sessionId)settle(id,new Error('CDP session detached before response; command outcome unknown'));
      for(const cancel of [...eventWaiters])if(cancel.sessionId===sessionId)cancel(new Error('CDP session detached before event; outcome unknown'));
      for(const key of eventListeners.keys())if(JSON.parse(key)[0]===sessionId)eventListeners.delete(key);
    },
    close() {
      disconnect("CDP client closed before response; command outcome unknown");
      if (ws.terminate) ws.terminate(); else ws.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function listTabs(proxy) {
  const targets = await proxy.listTargets();
  return targets
    .filter((t) => t.type === "page")
    .map((t) => ({ id: t.id, title: t.title, url: t.url }));
}

async function connect(proxy, targetId, options = {}) {
  if (!targetId) throw new Error("Explicit browser targetId is required");
  const targets = await proxy.listTargets();
  const matches = targets.filter(t => t.id === targetId && t.type === "page");
  if (matches.length !== 1) throw new Error(`Page target ${targetId} must match exactly once`);
  const target = matches[0];
  const debuggerURL = new URL(target.webSocketDebuggerUrl);
  const wsPath = debuggerURL.pathname;
  if (!["ws:", "wss:"].includes(debuggerURL.protocol) || wsPath !== `/devtools/page/${targetId}` || debuggerURL.search || debuggerURL.hash) {
    throw new Error("Debugger endpoint does not match the explicit page target");
  }
  const ws = await proxy.cdpConnect(wsPath);
  let cdp;
  try { cdp = makeCdpClient(ws, options); }
  catch (error) { if (ws.terminate) ws.terminate(); else ws.close(); throw error; }

  // Enable domains we commonly need
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("DOM.enable");
  } catch (error) {
    cdp.close(); // Failed setup must not leave a live socket behind.
    throw error;
  }

  // Network log accumulator
  const networkLog = [];
  const MAX_NETWORK_LOG = 100;

  cdp.on("Network.requestWillBeSent", (params) => {
    networkLog.push({
      type: "request",
      ts: params.timestamp,
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      postData: params.request.postData || null,
    });
    if (networkLog.length > MAX_NETWORK_LOG * 2) {
      networkLog.splice(0, networkLog.length - MAX_NETWORK_LOG);
    }
  });

  cdp.on("Network.responseReceived", (params) => {
    networkLog.push({
      type: "response",
      ts: params.timestamp,
      requestId: params.requestId,
      status: params.response.status,
      url: params.response.url,
      mimeType: params.response.mimeType,
    });
    if (networkLog.length > MAX_NETWORK_LOG * 2) {
      networkLog.splice(0, networkLog.length - MAX_NETWORK_LOG);
    }
  });

  // Console log accumulator
  const consoleLog = [];
  const MAX_CONSOLE_LOG = 100;

  cdp.on("Runtime.consoleAPICalled", (params) => {
    consoleLog.push({
      ts: params.timestamp,
      level: params.type, // log, warn, error, info, debug
      text: params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" "),
    });
    if (consoleLog.length > MAX_CONSOLE_LOG * 2) {
      consoleLog.splice(0, consoleLog.length - MAX_CONSOLE_LOG);
    }
  });

  // Also capture unhandled JS exceptions
  cdp.on("Runtime.exceptionThrown", (params) => {
    const detail = params.exceptionDetails;
    consoleLog.push({
      ts: params.timestamp,
      level: "exception",
      text: detail.exception?.description || detail.text || "unknown exception",
    });
  });

  // Route change accumulator (SPA navigation + full navigation)
  const routeLog = [];
  const MAX_ROUTE_LOG = 50;

  // SPA-style pushState/replaceState/hashchange
  cdp.on("Page.navigatedWithinDocument", (params) => {
    routeLog.push({
      ts: Date.now(),
      type: "spa",
      url: params.url,
    });
    if (routeLog.length > MAX_ROUTE_LOG) routeLog.shift();
  });

  // Full page navigation
  cdp.on("Page.frameNavigated", (params) => {
    // Only track top-level frame
    if (!params.frame.parentId) {
      routeLog.push({
        ts: Date.now(),
        type: "navigation",
        url: params.frame.url,
      });
      if (routeLog.length > MAX_ROUTE_LOG) routeLog.shift();
    }
  });

  // Toast/snackbar observer — inject MutationObserver into the page
  // It writes detected toasts into window.__cdpToasts for retrieval
  try {
  const initialized = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        if (window.__cdpToastObserver) return;
        window.__cdpToasts = [];
        const MAX = 50;

        const isToast = (el) => {
          if (!el || !el.getAttribute) return false;
          const role = el.getAttribute('role') || '';
          const ariaLive = el.getAttribute('aria-live') || '';
          const cls = (el.className || '').toLowerCase();
          // Match common toast/snackbar/notification patterns
          return role === 'alert' || role === 'status'
            || ariaLive === 'polite' || ariaLive === 'assertive'
            || cls.includes('toast') || cls.includes('snackbar')
            || cls.includes('notification') || cls.includes('alert')
            || cls.includes('flash') || cls.includes('message');
        };

        const extractText = (el) => (el.textContent || '').trim().substring(0, 200);

        window.__cdpToastObserver = new MutationObserver((mutations) => {
          for (const mut of mutations) {
            for (const node of mut.addedNodes) {
              if (node.nodeType !== 1) continue;
              // Check the node itself and immediate children
              const candidates = [node, ...node.querySelectorAll?.('*') || []];
              for (const el of candidates) {
                if (isToast(el)) {
                  const text = extractText(el);
                  if (text) {
                    window.__cdpToasts.push({ ts: Date.now(), text, role: el.getAttribute('role') || '', class: (el.className || '').substring(0, 80) });
                    if (window.__cdpToasts.length > MAX) window.__cdpToasts.shift();
                  }
                }
              }
            }
          }
        });
        window.__cdpToastObserver.observe(document.body, { childList: true, subtree: true });
      })()
    `,
  });

  if (initialized.exceptionDetails) throw new Error("Browser observer initialization failed");
  } catch (error) { cdp.close(); throw error; }

  // Return a session object with utility methods
  return {
    cdp,
    target,
    networkLog,
    consoleLog,
    routeLog,

    async snapshot(opts = {}) {
      return snapshot(cdp, opts);
    },
    async screenshot(outPath) {
      return screenshot(cdp, outPath);
    },
    async navigate(url) {
      return navigate(cdp, url);
    },
    async click(selector) {
      return click(cdp, selector);
    },
    async type(selector, text) {
      return typeText(cdp, selector, text);
    },
    async fill(selector, value) {
      return fillText(cdp, selector, value);
    },
    async eval(expression) {
      return evalJS(cdp, expression);
    },
    async findByText(text, opts) {
      return findByText(cdp, text, opts);
    },
    async findByRole(role, opts) {
      return findByRole(cdp, role, opts);
    },
    async findByLabel(labelText, opts) {
      return findByLabel(cdp, labelText, opts);
    },
    async waitForIdle(timeoutMs = 5000) {
      return waitForNetworkIdle(cdp, timeoutMs);
    },
    async waitForElement(selector, timeoutMs = 5000) {
      return waitForElement(cdp, selector, timeoutMs);
    },
    async waitForReady(options) {
      return waitForReady(cdp, options);
    },
    async waitForRoute(pattern, timeoutMs = 5000) {
      return waitForRoute(cdp, routeLog, pattern, timeoutMs);
    },
    getNetworkLog() {
      return [...networkLog];
    },
    getConsoleLog() {
      return [...consoleLog];
    },
    getRouteLog() {
      return [...routeLog];
    },
    async getToasts() {
      return getToasts(cdp);
    },
    close() {
      cdp.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot: accessibility tree as structured text
// ---------------------------------------------------------------------------

async function snapshot(cdp, opts = {}) {
  const { maxDepth = 15, maxLines = 0 } = opts;

  // Try accessibility tree first (most token-efficient, semantic)
  try {
    const result = await cdp.send("Accessibility.getFullAXTree", {
      max_depth: maxDepth,
    });

    if (result.nodes && result.nodes.length > 0) {
      const text = formatAxTree(result.nodes);
      return truncateSnapshot(text, maxLines);
    }
  } catch (err) {
    // Accessibility domain might not be available, fall back
  }

  // Fallback: extract visible text + interactive elements via JS
  const evalResult = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const result = [];
        const walk = (el, depth) => {
          if (depth > ${maxDepth}) return;
          const tag = el.tagName?.toLowerCase() || '';
          const role = el.getAttribute?.('role') || '';
          const ariaLabel = el.getAttribute?.('aria-label') || '';
          const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
            ? el.childNodes[0].textContent.trim() : '';
          const isInteractive = ['a','button','input','select','textarea'].includes(tag)
            || ['button','link','textbox','combobox','menuitem','tab','checkbox','radio'].includes(role);
          const isVisible = el.offsetParent !== null || el.tagName === 'BODY';
          if (!isVisible) return;

          if (isInteractive || text) {
            const indent = '  '.repeat(depth);
            let desc = tag;
            if (role) desc += '[role=' + role + ']';
            if (el.type) desc += '[type=' + el.type + ']';
            if (el.name) desc += '[name=' + el.name + ']';
            if (el.id) desc += '#' + el.id;
            if (ariaLabel) desc += ' "' + ariaLabel + '"';
            else if (text && text.length < 80) desc += ' "' + text + '"';
            else if (el.placeholder) desc += ' placeholder="' + el.placeholder + '"';
            if (el.href) desc += ' href=' + el.href;
            if (el.value && tag === 'input') desc += ' value="' + el.value.substring(0,40) + '"';
            result.push(indent + desc);
          }
          for (const child of el.children || []) {
            walk(child, depth + (isInteractive || text ? 1 : 0));
          }
        };
        walk(document.body, 0);
        return result.join('\\n');
      })()
    `,
    returnByValue: true,
  });

  const text = evalResult.result.value || "(empty page)";
  return truncateSnapshot(text, maxLines);
}

// Format accessibility tree nodes into readable text
function formatAxTree(nodes) {
  // Build parent-child map
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  const lines = [];

  function getProperty(node, name) {
    if (!node.properties) return null;
    const prop = node.properties.find((p) => p.name === name);
    return prop?.value?.value ?? null;
  }

  function getName(node) {
    return node.name?.value || "";
  }

  function getRole(node) {
    return node.role?.value || "";
  }

  function formatNode(node, depth) {
    const role = getRole(node);
    const name = getName(node);
    const indent = "  ".repeat(depth);

    // Skip generic/none roles with no name
    if ((role === "generic" || role === "none" || !role) && !name) {
      // Still recurse into children
      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = nodeMap.get(childId);
          if (child) formatNode(child, depth);
        }
      }
      return;
    }

    // Skip InlineTextBox — redundant with parent StaticText
    if (role === "InlineTextBox") return;

    let line = `${indent}[${role}]`;
    if (name) line += ` "${name}"`;

    // Add useful properties
    const focused = getProperty(node, "focused");
    const checked = getProperty(node, "checked");
    const disabled = getProperty(node, "disabled");
    const expanded = getProperty(node, "expanded");
    const value = node.value?.value;

    const flags = [];
    if (focused) flags.push("focused");
    if (checked === "true" || checked === "mixed") flags.push(`checked=${checked}`);
    if (disabled) flags.push("disabled");
    if (expanded !== null && expanded !== undefined) flags.push(`expanded=${expanded}`);
    if (value && value !== name) flags.push(`value="${String(value).substring(0, 40)}"`);
    if (flags.length) line += ` (${flags.join(", ")})`;

    lines.push(line);

    if (node.childIds) {
      for (const childId of node.childIds) {
        const child = nodeMap.get(childId);
        if (child) formatNode(child, depth + 1);
      }
    }
  }

  // Find root and walk
  const root = nodes[0];
  if (root) formatNode(root, 0);

  return lines.join("\n") || "(empty accessibility tree)";
}

// Truncate snapshot to maxLines, preserving structure context
function truncateSnapshot(text, maxLines) {
  if (!maxLines || maxLines <= 0) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines);
  kept.push(`\n... (${lines.length - maxLines} more lines, ${lines.length} total)`);
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Find elements by visible text (returns matches with selectors and context)
// ---------------------------------------------------------------------------

async function findByText(cdp, searchText, opts = {}) {
  const { tag = "*", exact = false, action = null } = opts;
  const result = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const search = ${JSON.stringify(searchText)};
        const exact = ${exact};
        const tagFilter = ${JSON.stringify(tag)};
        const matches = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (tagFilter !== '*' && el.tagName.toLowerCase() !== tagFilter.toLowerCase()) continue;
          if (el.offsetParent === null && el.tagName !== 'BODY') continue;

          const text = (el.textContent || '').trim();
          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join(' ');
          const ariaLabel = el.getAttribute('aria-label') || '';
          const placeholder = el.placeholder || '';

          const candidates = [directText, ariaLabel, placeholder];
          const hit = exact
            ? candidates.some(c => c === search)
            : candidates.some(c => c.toLowerCase().includes(search.toLowerCase()))
              || (text.length < 200 && text.toLowerCase().includes(search.toLowerCase()));

          if (!hit) continue;

          // Build a usable selector (ranked by stability)
          let selector = '';
          if (el.id) selector = '#' + CSS.escape(el.id);
          else if (el.getAttribute('data-testid')) selector = '[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']';
          else if (el.name) selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
          else if (ariaLabel) selector = el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
          else if (el.href) {
            // For links, use href path as selector (stable across sessions)
            try {
              const path = new URL(el.href).pathname;
              selector = 'a[href="' + path + '"]';
            } catch(_) {
              selector = 'a[href="' + el.getAttribute('href') + '"]';
            }
          }
          else selector = el.tagName.toLowerCase() + ':nth-of-type(?)';

          matches.push({
            tag: el.tagName.toLowerCase(),
            text: directText.substring(0, 100) || text.substring(0, 100),
            role: el.getAttribute('role') || '',
            ariaLabel,
            selector,
            href: el.href || null,
          });
          if (matches.length >= 20) break;
        }
        return JSON.stringify(matches);
      })()
    `,
    returnByValue: true,
  });

  const matches = JSON.parse(result.result.value);

  // Optionally click the first match
  if (action === "click" && matches.length > 0) {
    await click(cdp, matches[0].selector);
    matches[0].clicked = true;
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Find elements by ARIA role (returns matches with selectors and names)
// ---------------------------------------------------------------------------

async function findByRole(cdp, role, opts = {}) {
  const { name = null } = opts;
  const result = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const targetRole = ${JSON.stringify(role)};
        const targetName = ${JSON.stringify(name)};
        const matches = [];

        // Check explicit role attribute + implicit roles for common tags
        const implicitRoles = {
          'a': 'link', 'button': 'button', 'input': 'textbox',
          'textarea': 'textbox', 'select': 'combobox', 'nav': 'navigation',
          'main': 'main', 'header': 'banner', 'footer': 'contentinfo',
          'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
          'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
          'img': 'img', 'table': 'table', 'form': 'form',
        };

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el.offsetParent === null && el.tagName !== 'BODY') continue;
          const elRole = el.getAttribute('role') || implicitRoles[el.tagName.toLowerCase()] || '';
          if (elRole !== targetRole) continue;

          const elName = el.getAttribute('aria-label')
            || el.textContent?.trim().substring(0, 100)
            || el.placeholder || '';

          if (targetName && !elName.toLowerCase().includes(targetName.toLowerCase())) continue;

          let selector = '';
          if (el.id) selector = '#' + CSS.escape(el.id);
          else if (el.getAttribute('data-testid')) selector = '[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']';
          else if (el.name) selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
          else if (el.getAttribute('aria-label')) selector = '[aria-label=' + JSON.stringify(el.getAttribute('aria-label')) + ']';
          else if (el.href) {
            try {
              const path = new URL(el.href).pathname;
              selector = 'a[href="' + path + '"]';
            } catch(_) {
              selector = 'a[href="' + el.getAttribute('href') + '"]';
            }
          }
          else selector = el.tagName.toLowerCase() + '[role=' + JSON.stringify(targetRole) + ']';

          matches.push({
            tag: el.tagName.toLowerCase(),
            role: elRole,
            name: elName.substring(0, 100),
            selector,
            href: el.href || null,
          });
          if (matches.length >= 20) break;
        }
        return JSON.stringify(matches);
      })()
    `,
    returnByValue: true,
  });

  return JSON.parse(result.result.value);
}

// ---------------------------------------------------------------------------
// Find elements by associated label text (<label for="..."> or proximity)
// ---------------------------------------------------------------------------

async function findByLabel(cdp, labelText, opts = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const search = ${JSON.stringify(labelText)};
        const matches = [];

        const labels = document.querySelectorAll('label');
        for (const label of labels) {
          const text = label.textContent.trim();
          if (!text.toLowerCase().includes(search.toLowerCase())) continue;

          let input = null;
          let method = '';

          // Strategy 1: label[for] -> getElementById
          if (label.htmlFor) {
            input = document.getElementById(label.htmlFor);
            method = 'for-attribute';
          }

          // Strategy 2: input nested inside label
          if (!input) {
            input = label.querySelector('input, textarea, select, [contenteditable]');
            if (input) method = 'nested';
          }

          // Strategy 3: next sibling element
          if (!input) {
            let sibling = label.nextElementSibling;
            if (sibling && ['INPUT','TEXTAREA','SELECT'].includes(sibling.tagName)) {
              input = sibling;
              method = 'next-sibling';
            }
          }

          // Strategy 4: aria-labelledby reverse lookup
          if (!input) {
            if (label.id) {
              input = document.querySelector('[aria-labelledby="' + label.id + '"]');
              if (input) method = 'aria-labelledby';
            }
          }

          if (!input) continue;
          if (input.offsetParent === null) continue;

          let selector = '';
          if (input.id) selector = '#' + CSS.escape(input.id);
          else if (input.name) selector = input.tagName.toLowerCase() + '[name=' + JSON.stringify(input.name) + ']';
          else if (input.getAttribute('data-testid')) selector = '[data-testid=' + JSON.stringify(input.getAttribute('data-testid')) + ']';
          else if (input.getAttribute('aria-label')) selector = '[aria-label=' + JSON.stringify(input.getAttribute('aria-label')) + ']';
          else selector = input.tagName.toLowerCase() + ':nth-of-type(?)';

          matches.push({
            label: text.substring(0, 100),
            method,
            tag: input.tagName.toLowerCase(),
            type: input.type || null,
            selector,
            name: input.name || null,
            id: input.id || null,
          });
        }

        // Also check aria-label on inputs directly (no <label> element)
        const inputs = document.querySelectorAll('input, textarea, select');
        for (const input of inputs) {
          const ariaLabel = input.getAttribute('aria-label') || '';
          const placeholder = input.placeholder || '';
          if (!ariaLabel.toLowerCase().includes(search.toLowerCase())
              && !placeholder.toLowerCase().includes(search.toLowerCase())) continue;
          if (input.offsetParent === null) continue;
          // Avoid duplicates
          if (matches.some(m => m.selector && document.querySelector(m.selector) === input)) continue;

          let selector = '';
          if (input.id) selector = '#' + CSS.escape(input.id);
          else if (input.name) selector = input.tagName.toLowerCase() + '[name=' + JSON.stringify(input.name) + ']';
          else if (ariaLabel) selector = '[aria-label=' + JSON.stringify(ariaLabel) + ']';
          else if (placeholder) selector = input.tagName.toLowerCase() + '[placeholder=' + JSON.stringify(placeholder) + ']';
          else selector = input.tagName.toLowerCase() + ':nth-of-type(?)';

          matches.push({
            label: ariaLabel || placeholder,
            method: ariaLabel ? 'aria-label' : 'placeholder',
            tag: input.tagName.toLowerCase(),
            type: input.type || null,
            selector,
            name: input.name || null,
            id: input.id || null,
          });
        }

        return JSON.stringify(matches);
      })()
    `,
    returnByValue: true,
  });

  return JSON.parse(result.result.value);
}

// ---------------------------------------------------------------------------
// Wait for element to appear in DOM
// ---------------------------------------------------------------------------

async function waitForElement(cdp, selector, timeoutMs = 5000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `
      new Promise((resolve, reject) => {
        const sel = ${JSON.stringify(selector)};
        const timeout = ${timeoutMs};

        // Check if already present
        const existing = document.querySelector(sel);
        if (existing) {
          resolve(JSON.stringify({ found: true, tag: existing.tagName.toLowerCase(), text: (existing.textContent || '').trim().substring(0, 100) }));
          return;
        }

        // Watch for it via MutationObserver
        let timer;
        const observer = new MutationObserver(() => {
          const el = document.querySelector(sel);
          if (el) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(JSON.stringify({ found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 100) }));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });

        timer = setTimeout(() => {
          observer.disconnect();
          resolve(JSON.stringify({ found: false, selector: sel }));
        }, timeout);
      })
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  return JSON.parse(result.result.value);
}

async function waitForReady(cdp, { selectors = [], predicate = null, timeoutMs = 15000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Array.isArray(selectors) ||
      selectors.some(value => typeof value !== "string") ||
      (predicate !== null && (typeof predicate !== "string" || !predicate.trim())) ||
      (!selectors.length && !predicate)) {
    throw new Error("Readiness requires observed selectors or an application predicate, and a positive timeout");
  }
  const source = fs.readFileSync(path.join(__dirname, "browser-readiness.function.js"), "utf8");
  const response = await cdp.send("Runtime.evaluate", {
    expression: `${source}(${JSON.stringify({ selectors, predicate, timeoutMs })})`,
    returnByValue: true, awaitPromise: true,
  });
  const result = response.result && response.result.value;
  if (!result || result.ready !== true) {
    throw new Error(`Browser readiness failed: ${(result && result.unmet || ["condition_unknown"]).join(", ")}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wait for route (URL) to match a pattern
// ---------------------------------------------------------------------------

async function waitForRoute(cdp, routeLog, pattern, timeoutMs = 5000) {
  if (typeof pattern !== "string" || !pattern || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Route pattern and positive timeout required");
  const deadline = Date.now() + timeoutMs;
  let url;
  do {
    const result = await cdp.send("Runtime.evaluate", { expression: "window.location.href", returnByValue: true },
      { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (result.exceptionDetails || typeof result.result?.value !== "string") throw new Error("Route observation failed");
    url = result.result.value;
    if (url.includes(pattern)) return { matched: true, url, type: "current" };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { matched: false, pattern, currentUrl: url };
}

// ---------------------------------------------------------------------------
// Get toasts captured by the injected MutationObserver
// ---------------------------------------------------------------------------

async function getToasts(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__cdpToasts || [])",
    returnByValue: true,
  });
  return JSON.parse(result.result.value);
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async function screenshot(cdp, outPath) {
  if (!outPath) throw new Error("An explicit screenshot output path is required");
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    quality: 80,
  });
  const buffer = Buffer.from(result.data, "base64");
  const resolvedPath = outPath;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolvedPath, buffer);
  return resolvedPath;
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

async function navigate(cdp, url) {
  const loadPromise = cdp.once("Page.loadEventFired");
  try {
    const [navResult] = await Promise.all([
      cdp.send("Page.navigate", { url }).then(result => {
        if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
        return result;
      }), loadPromise,
    ]);
    return navResult;
  } finally { loadPromise.cancel(); }
}

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

async function click(cdp, selector) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ error: 'Element not found' });
        el.scrollIntoView({ block: 'center' });
        el.click();
        return JSON.stringify({ ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) });
      })()
    `,
    returnByValue: true,
  });
  const parsed = JSON.parse(result.result.value);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

// ---------------------------------------------------------------------------
// Replace a form value; typeText below retains keyboard insertion semantics.
// ---------------------------------------------------------------------------

async function fillText(cdp, selector, value) {
  if (typeof selector !== 'string' || typeof value !== 'string') {
    throw new Error('fill requires a selector and a string value');
  }
  await waitForReady(cdp, { selectors: [selector] });
  const source = fs.readFileSync(path.join(__dirname, 'browser-fill.function.js'), 'utf8');
  const result = await cdp.send('Runtime.evaluate', {
    expression: `${source}(${JSON.stringify({ selector, value })})`,
    returnByValue: true,
  });
  if (result.exceptionDetails || result.result?.value?.ok !== true) {
    throw new Error('Field replacement was not verified; do not submit');
  }
  return { ok: true };
}

async function typeText(cdp, selector, text) {
  // Focus the element
  const focused = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found');
        el.scrollIntoView({ block: 'center' });
        el.focus();
        el.click();
      })()
    `,
  });

  if (focused.exceptionDetails) throw new Error("Focus failed; text was not dispatched");

  // Use Input.dispatchKeyEvent for realistic typing
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
      key: char,
      unmodifiedText: char,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
    });
  }

  return { ok: true, selector, length: text.length };
}

// ---------------------------------------------------------------------------
// Eval JS
// ---------------------------------------------------------------------------

async function evalJS(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `JS error: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description}`
    );
  }
  return result.result.value;
}

// ---------------------------------------------------------------------------
// Wait for network idle
// ---------------------------------------------------------------------------

async function waitForNetworkIdle(cdp, timeoutMs = 5000, quietMs = 500) {
  if (![timeoutMs, quietMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Positive idle deadlines required");
  return new Promise(resolve => {
    const requests = new Set();
    let quiet;
    const cleanup = () => {
      clearTimeout(quiet); clearTimeout(deadline);
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.loadingFailed", onDone);
      cdp.off("Network.loadingFinished", onDone);
    };
    const finish = idle => { cleanup(); resolve({ idle, pending: requests.size, coverage: "requests_since_attachment" }); };
    const check = () => { clearTimeout(quiet); if (!requests.size) quiet = setTimeout(() => finish(true), quietMs); };
    const onRequest = params => { requests.add(params.requestId); clearTimeout(quiet); };
    const onDone = params => { requests.delete(params.requestId); check(); };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    cdp.on("Network.requestWillBeSent", onRequest);
    cdp.on("Network.loadingFailed", onDone);
    cdp.on("Network.loadingFinished", onDone);
    check();
  });
}

// ---------------------------------------------------------------------------
// CLI interface

module.exports = { createCdpProxy, connect, listTabs, makeCdpClient, snapshot, screenshot, navigate, click, typeText, fillText, evalJS, findByText, findByRole, findByLabel, waitForNetworkIdle, waitForElement, waitForReady, waitForRoute, getToasts };
