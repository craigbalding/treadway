#!/usr/bin/env python3
"""Narrow Chrome native host. No token is returned, logged or persisted.

Uses inherited SafeYolo proxy/CA settings and reads the current guest token for
each command. Installation is explicit; imports perform no network operations.
"""
import json
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path

ORIGIN = "http://_safeyolo.proxy.internal"
TOKEN = Path("/app/agent_token")
OPERATIONS = {"health": ("GET", "/health"), "read": ("GET", "/api/test-context/current"),
              "declare": ("POST", "/api/test-context/current"), "clear": ("DELETE", "/api/test-context/current")}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def open_request(request, **options):
    # Keep environment proxy handling, but never forward the bearer to redirects.
    return urllib.request.build_opener(NoRedirect()).open(request, **options)


def handle(message):
    if not isinstance(message, dict) or message.get("operation") not in OPERATIONS:
        raise ValueError("Unsupported SafeYolo operation")
    if set(message) - {"operation", "body"}:
        raise ValueError("Unsupported SafeYolo command fields")
    method, path = OPERATIONS[message["operation"]]
    if message["operation"] == "health" and not TOKEN.is_file():
        return {"available": False}
    token = TOKEN.read_text().strip()
    if not token:
        raise ValueError("SafeYolo token is unavailable")
    headers = {"Authorization": "Bearer " + token}
    body = None
    if method == "POST":
        value = message.get("body")
        if not isinstance(value, dict) or set(value) != {"context", "ttl"}:
            raise ValueError("Invalid context declaration")
        if not isinstance(value["context"], str) or not isinstance(value["ttl"], (int, float)):
            raise ValueError("Invalid context declaration")
        body = json.dumps(value).encode()
        headers["Content-Type"] = "application/json"
    elif "body" in message:
        raise ValueError("Unexpected body")
    request = urllib.request.Request(ORIGIN + path, data=body, headers=headers, method=method)
    try:
        with open_request(request, timeout=15) as response:
            return {"status": response.status, "data": json.load(response)}
    except urllib.error.HTTPError as error:
        # Preserve status without echoing a potentially credential-bearing body.
        return {"status": error.code, "data": {"error": "SafeYolo refused the operation"}}


def main():
    while True:
        header = sys.stdin.buffer.read(4)
        if not header:
            return
        if len(header) != 4:
            return
        length = struct.unpack("=I", header)[0]
        if length > 1024 * 1024:
            return
        raw = sys.stdin.buffer.read(length)
        if len(raw) != length:
            return
        try:
            result = handle(json.loads(raw))
        except Exception:
            result = {"error": "SafeYolo helper unavailable or operation failed"}
        encoded = json.dumps(result).encode()
        sys.stdout.buffer.write(struct.pack("=I", len(encoded)) + encoded)
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
