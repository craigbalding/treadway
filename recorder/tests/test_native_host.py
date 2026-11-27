"""Offline native-host boundary checks; never contacts SafeYolo."""
import importlib.util
import json
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("safeyolo_host", Path(__file__).parents[1] / "native/safeyolo_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def read(self):
        return json.dumps({"agent_api": "ok"}).encode()


class NativeHostTests(unittest.TestCase):
    def test_redirect_is_not_followed_with_a_bearer_header(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                seen.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/second")
                self.end_headers()
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(HTTPError) as raised:
                host.open_request(Request(f"http://127.0.0.1:{server.server_port}/first", headers={"Authorization": "Bearer fixture-only"}), timeout=2)
            self.assertEqual(raised.exception.code, 302)
            self.assertEqual(seen, ["/first"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_reads_current_token_each_operation_and_never_returns_it(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            observed = []
            def request(value, **_options):
                observed.append(value)
                return Response()
            with patch.object(host, "TOKEN", token), patch.object(host, "open_request", request):
                token.write_text("fixture-token-one")
                first = host.handle({"operation": "health"})
                token.write_text("fixture-token-two")
                second = host.handle({"operation": "health"})
            self.assertEqual([item.get_header("Authorization") for item in observed], ["Bearer fixture-token-one", "Bearer fixture-token-two"])
            self.assertNotIn("fixture-token", json.dumps([first, second]))
            self.assertTrue(all(item.full_url == "http://_safeyolo.proxy.internal/health" for item in observed))

    def test_no_token_means_optional_integration_absent_without_network(self):
        with patch.object(host, "TOKEN", Path("/missing-fixture/token")), patch.object(host, "open_request") as request:
            self.assertEqual(host.handle({"operation": "health"}), {"available": False})
            request.assert_not_called()

    def test_unknown_operations_and_arbitrary_url_fields_refused(self):
        with patch.object(host, "open_request") as request:
            for value in [{"operation": "fetch"}, {"operation": "health", "url": "https://example.test"}]:
                with self.assertRaises(ValueError):
                    host.handle(value)
            request.assert_not_called()

    def test_declaration_body_has_only_context_and_ttl(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            token.write_text("fixture-token")
            with patch.object(host, "TOKEN", token), patch.object(host, "open_request") as request:
                with self.assertRaises(ValueError):
                    host.handle({"operation": "declare", "body": {"context": "run=x", "ttl": 60, "url": "elsewhere"}})
                request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
