"""Python access to the installed Node CDP transport; no second browser engine."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time


class CdpSocket:
    def __init__(self, *, host, port, target_id, timeout_seconds=10, events=()):
        if not target_id:
            raise ValueError("explicit_target_required")
        self.timeout = timeout_seconds
        self.buffer = b""
        self.process = subprocess.Popen(["node", str(Path(__file__).with_name("browser") / "bridge.js")],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        try:
            self.send(json.dumps({"cdpHost": host, "cdpPort": port, "targetId": target_id,
                                  "events": list(events), "commandTimeoutMs": int(timeout_seconds*1000)}))
            if json.loads(self.recv()).get("ready") is not True:
                raise RuntimeError("cdp_bridge_setup_incomplete")
        except BaseException:
            self.close()
            raise

    def settimeout(self, seconds):
        self.timeout = seconds

    def send(self, value):
        try:
            self.process.stdin.write(value.encode()+b"\n")
            self.process.stdin.flush()
        except OSError:
            raise RuntimeError("cdp_bridge_send_incomplete; outcome unknown") from None

    def recv(self):
        deadline = time.monotonic()+self.timeout
        while b"\n" not in self.buffer:
            remaining = deadline-time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("cdp_bridge_observation_deadline; outcome unknown")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("cdp_bridge_closed; outcome unknown")
            self.buffer += chunk
            if len(self.buffer) > 4*1024*1024:
                raise RuntimeError("cdp_bridge_message_limit; outcome unknown")
        line, self.buffer = self.buffer.split(b"\n", 1)
        return line.decode()

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.selector.close()
        for stream in (self.process.stdin, self.process.stdout):
            stream.close()


class CommandSession:
    """Correlate commands while retaining subscribed events for an observer."""
    def __init__(self, socket):
        self.socket = socket
        self.next_id = 0
        self.events = []

    def command(self, method, params=None, *, timeout_seconds=30):
        self.next_id += 1
        command_id = self.next_id
        self.socket.send(json.dumps({"id": command_id, "method": method, "params": params or {},
                                     "options": {"timeoutMs": int(timeout_seconds*1000)}}))
        deadline = time.monotonic()+timeout_seconds
        while time.monotonic() < deadline:
            self.socket.settimeout(max(.001, deadline-time.monotonic()))
            try:
                reply = json.loads(self.socket.recv())
            except TimeoutError:
                continue
            if reply.get("id") == command_id:
                if reply.get("error"):
                    raise RuntimeError("cdp_command_incomplete; outcome unknown")
                return reply.get("result", {})
            if reply.get("method"):
                if len(self.events) >= 1000:
                    raise RuntimeError("cdp_event_limit; observation incomplete")
                self.events.append(reply)
        raise TimeoutError("cdp_command_deadline; outcome unknown")
