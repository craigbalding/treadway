'use strict';

module.exports = Object.freeze({
  DEFAULT_RESPONSE_BODY_BYTES: 64 * 1024 * 1024,
  DEFAULT_TRANSFER_BYTES: 256 * 1024 * 1024,
  MAX_BROWSER_STATE_BYTES: 64 * 1024 * 1024,
  // Leave headroom for JSON/base64 and paired parsed/text observations.
  MAX_BROWSER_MESSAGE_BYTES: 256 * 1024 * 1024,
});
