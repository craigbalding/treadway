"""Generous transport/storage budgets for ordinary application payloads."""

DEFAULT_RESPONSE_BODY_BYTES = 64 * 1024 * 1024
MAX_REQUEST_TIMEOUT_SECONDS = 3600
MAX_BROWSER_STATE_BYTES = 64 * 1024 * 1024
# JSON, base64 and paired parsed/text observations can exceed the raw body size.
MAX_BROWSER_MESSAGE_BYTES = 256 * 1024 * 1024
