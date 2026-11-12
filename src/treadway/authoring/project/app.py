"""Synthetic loopback-only workboard. All persisted effects live in SQLite."""
from __future__ import annotations

from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qs, urlparse
import uuid

PEOPLE = [{"id": "person-17", "name": "Casey Rowan"},
          {"id": "person-29", "name": "Sam Morgan"}]
ACTOR = "fixture-author"
ROOT = Path(__file__).resolve().parent


def validate_edit(value):
    if value.get("ownerId") not in {person["id"] for person in PEOPLE}:
        raise ValueError("unknown_owner_id")
    start, due = value.get("start"), value.get("due")
    if not isinstance(start, str) or not isinstance(due, str):
        raise ValueError("explicit_dates_required")
    if date.fromisoformat(start).isoformat() != start or date.fromisoformat(due).isoformat() != due or due < start:
        raise ValueError("ordered_iso_dates_required")
    if not isinstance(value.get("note"), str) or not value["note"].strip():
        raise ValueError("explicit_note_required")
    return {key: value[key] for key in ("ownerId", "start", "due", "note")}


def make_server(database: Path):
    from collaboration import initialize, handle
    database = Path(database)
    initialize(database)
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL)")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, value, cookie=None):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            if cookie:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("bounded_json_required")
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise ValueError("object_required")
            return value

        def do_GET(self):
            if handle(self, database):
                return
            url = urlparse(self.path)
            if url.path in {"/", "/app.js"}:
                file = ROOT / ("app.html" if url.path == "/" else "app.js")
                body = file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html" if url.path == "/" else "text/javascript")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif url.path == "/api/people":
                query = parse_qs(url.query).get("q", [""])[0]
                self.respond(200, {"query": query, "people": [person for person in PEOPLE if query.casefold() in person["name"].casefold()]})
            elif url.path == "/api/actor":
                self.respond(200, {"actor": ACTOR})
            elif re.fullmatch(r"/api/items/[0-9a-f]{32}", url.path):
                with sqlite3.connect(database) as db:
                    row = db.execute("SELECT value FROM items WHERE id=?", (url.path.rsplit("/", 1)[1],)).fetchone()
                self.respond(200 if row else 404, json.loads(row[0]) if row else {"error": "absent"})
            else:
                self.respond(404, {"error": "unknown_route"})

        def mutate(self):
            if handle(self, database):
                return
            try:
                value = self.body()
                with sqlite3.connect(database, timeout=3) as db:
                    db.execute("BEGIN IMMEDIATE")
                    if self.path == "/api/items" and self.command == "POST":
                        if not isinstance(value.get("title"), str) or not value["title"].strip() or not re.fullmatch(r"[0-9a-f]{32}", value.get("run", "")):
                            raise ValueError("explicit_title_and_run_required")
                        item = {"id": uuid.uuid4().hex, "run": value["run"], "actor": ACTOR,
                                "title": value["title"], "revision": 1, "ownerId": "",
                                "start": "", "due": "", "note": "", "writes": 0}
                        db.execute("INSERT INTO items VALUES (?,?)", (item["id"], json.dumps(item)))
                        db.commit()
                        self.respond(201, item)
                        return
                    route = re.fullmatch(r"/api/items/([0-9a-f]{32})(/advance)?", self.path)
                    if not route:
                        self.respond(404, {"error": "unknown_route"})
                        return
                    row = db.execute("SELECT value FROM items WHERE id=?", (route[1],)).fetchone()
                    if not row:
                        self.respond(404, {"error": "absent"})
                        return
                    item = json.loads(row[0])
                    if value.get("run") != item["run"]:
                        self.respond(403, {"error": "run_scope_differs"})
                        return
                    if self.command == "DELETE" and not route[2]:
                        db.execute("DELETE FROM items WHERE id=?", (item["id"],))
                        db.commit()
                        self.respond(200, {"deleted": item["id"]})
                        return
                    if self.command != "POST":
                        self.respond(405, {"error": "method_differs"})
                        return
                    if route[2]:
                        item["revision"] += 1  # Explicit synthetic competing writer.
                    else:
                        if type(value.get("revision")) is not int or value["revision"] != item["revision"]:
                            self.respond(409, {"error": "stale_revision", "revision": item["revision"]})
                            return
                        item.update(validate_edit(value))
                        item["revision"] += 1
                        item["writes"] += 1
                    db.execute("UPDATE items SET value=? WHERE id=?", (json.dumps(item), item["id"]))
                    db.commit()
                    self.respond(200, item)
            except (ValueError, TypeError, KeyError) as error:
                self.respond(400, {"error": str(error)})

        do_POST = mutate
        do_DELETE = mutate

    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)
