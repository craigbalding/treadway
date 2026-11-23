"""Run only local invented traffic. No server starts on import."""
import json
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    import robot

    claims = {}
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, body):
            encoded = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            actor = self.headers.get("X-Fixture-Actor")
            calls.append(("GET", self.path, actor))
            if self.path == "/api/me":
                return self.respond(200, {"id": actor, "role": "submitter"})
            claim = claims.get(self.path.removeprefix("/api/claims/"))
            if not claim or claim["owner"] != actor:
                return self.respond(404, {})
            self.respond(200, claim)

        def do_POST(self):
            actor = self.headers.get("X-Fixture-Actor")
            calls.append(("POST", self.path, actor))
            if self.path != "/api/claims":
                return self.respond(404, {})
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            resource_id = "claim-" + str(len(claims) + 1)
            claims[resource_id] = {"id": resource_id, "owner": actor, **body}
            self.respond(201, {"id": resource_id})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="treadway-conversion-") as output:
            result = robot.run(
                str(Path(__file__).with_name("claims.robot")),
                variable=[f"ORIGIN:http://127.0.0.1:{server.server_port}"],
                outputdir=output,
            )
        expected = [
            ("GET", "/api/me", "casey-fresh"), ("POST", "/api/claims", "casey-fresh"),
            ("GET", "/api/claims/claim-1", "casey-fresh"),
            ("GET", "/api/me", "sam-fresh"), ("POST", "/api/claims", "sam-fresh"),
            ("GET", "/api/claims/claim-2", "sam-fresh"),
            ("GET", "/api/me", "casey-fresh"),
        ]
        if result or calls != expected or len(claims) != 2:
            raise AssertionError("conversion_composition_differs")
        print("Two fresh principals persisted distinct claims; wrong principal dispatched no mutation.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
