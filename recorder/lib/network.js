// Passive network metadata. Bodies remain in SafeYOLO's flow store.
(function (root) {
  'use strict';
  function headerValues(headers, name) {
    return (headers || []).filter((entry) => entry.name.toLowerCase() === name.toLowerCase())
      .map((entry) => entry.value).filter((value) => typeof value === 'string' && value !== '');
  }
  function flowReference(headers) {
    const ids = [...new Set(headerValues(headers, 'x-safeyolo-request-id'))];
    return { safeyoloRequestId: ids.length === 1 ? ids[0] : null,
      flowCorrelation: ids.length === 1 ? 'response_header' : ids.length ? 'ambiguous_header' : 'missing_header',
      ...(ids.length > 1 ? { observedRequestIds: ids } : {}) };
  }
  function at(timeStamp) {
    return new Date(Number.isFinite(timeStamp) ? timeStamp : Date.now()).toISOString();
  }
  function metadata(details) {
    return {
      at: at(details.timeStamp), chromeRequestId: details.requestId,
      url: details.url, method: details.method, resourceType: details.type,
      tabId: details.tabId, frameId: details.frameId,
      ...(details.documentId ? { documentId: details.documentId } : {}),
      ...(details.parentDocumentId ? { parentDocumentId: details.parentDocumentId } : {}),
      ...(details.initiator ? { initiator: details.initiator } : {}),
    };
  }
  function isContextBlock(details) {
    return details.statusCode === 428 &&
      headerValues(details.responseHeaders, 'x-blocked-by').some((value) => value.toLowerCase() === 'test-context');
  }
  const api = { headerValues, flowReference, at, metadata, isContextBlock };
  root.TreadwayNetwork = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
