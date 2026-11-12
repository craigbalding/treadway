"""Synthetic multi-principal approval and private-resource fixture.

This module is application code, not a policy supplied by the shared library.
"""
import json
import re
import sqlite3
import uuid
from http.cookies import SimpleCookie

USERS = {"casey": "user-casey", "sam": "user-sam"}


def approval_error(resource, principal, revision):
    if type(revision) is not int or revision != resource["revision"]:
        return 409, "stale_revision"
    if principal == resource["creator"]:
        return 403, "self_approval"
    if resource["approvedBy"] is not None:
        return 409, "already_approved"
    return None


def can_read(resource, principal):
    return principal is not None and (resource["kind"] != "private" or principal == resource["creator"])


def initialize(database):
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, principal TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, value TEXT NOT NULL)")


def handle(handler, database):
    path = handler.path
    if path == "/collaboration":
        body = b'<!doctype html><title>Shared work requests</title><h1>Shared work requests</h1><p>Each browser has its own session.</p><input id="account"><input id="password" type="password">'
        handler.send_response(200)
        handler.send_header("Content-Type", "text/html")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        return True
    if not path.startswith("/api/collaboration/"):
        return False
    cookie = SimpleCookie()
    cookie.load(handler.headers.get("Cookie", ""))
    token = cookie.get("fixture-session")
    with sqlite3.connect(database, timeout=3) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT principal FROM sessions WHERE token=?", (token.value if token else "",)).fetchone()
        principal = row[0] if row else None
        if path == "/api/collaboration/session" and handler.command == "GET":
            handler.respond(200, {"principal": principal, "tenant": "synthetic-team", "approver": principal is not None})
            return True
        try:
            if path == "/api/collaboration/login" and handler.command == "POST":
                value = handler.body()
                if value.get("account") not in USERS or value.get("password") != "synthetic-only":
                    handler.respond(401, {"error": "credentials_refused"})
                    return True
                token = uuid.uuid4().hex
                db.execute("INSERT INTO sessions VALUES (?,?)", (token, USERS[value["account"]]))
                db.commit()
                handler.respond(200, {"loggedIn": True}, cookie="fixture-session=" + token + "; HttpOnly; SameSite=Strict; Path=/")
                return True
            if principal is None:
                handler.respond(401, {"error": "authentication_required"})
                return True
            if path == "/api/collaboration/resources" and handler.command == "POST":
                value = handler.body()
                if not re.fullmatch(r"[0-9a-f]{32}", value.get("run", "")) or value.get("kind") not in {"request", "private"}:
                    raise ValueError("explicit_run_and_kind_required")
                resource = {"id": uuid.uuid4().hex, "run": value["run"], "creator": principal,
                            "kind": value["kind"], "content": "Synthetic private content", "revision": 1,
                            "approvedBy": None, "approvalWrites": 0}
                db.execute("INSERT INTO resources VALUES (?,?)", (resource["id"], json.dumps(resource)))
                db.commit()
                handler.respond(201, resource)
                return True
            route = re.fullmatch(r"/api/collaboration/resources/([0-9a-f]{32})(/approve)?", path)
            if not route:
                handler.respond(404, {"error": "route_absent"})
                return True
            row = db.execute("SELECT value FROM resources WHERE id=?", (route[1],)).fetchone()
            if not row:
                handler.respond(404, {"error": "resource_absent"})
                return True
            resource = json.loads(row[0])
            if not can_read(resource, principal):
                handler.respond(403, {"error": "private_resource"})
                return True
            if handler.command == "GET" and not route[2]:
                handler.respond(200, resource)
                return True
            value = handler.body()
            if value.get("run") != resource["run"]:
                handler.respond(403, {"error": "run_differs"})
            elif handler.command == "DELETE" and not route[2] and principal == resource["creator"]:
                db.execute("DELETE FROM resources WHERE id=?", (resource["id"],))
                db.commit()
                handler.respond(200, {"deleted": resource["id"]})
            elif handler.command == "POST" and route[2] and resource["kind"] == "request":
                refused = approval_error(resource, principal, value.get("revision"))
                if refused:
                    handler.respond(refused[0], {"error": refused[1]})
                else:
                    resource.update(approvedBy=principal, approvalWrites=1, revision=resource["revision"]+1)
                    db.execute("UPDATE resources SET value=? WHERE id=?", (json.dumps(resource), resource["id"]))
                    db.commit()
                    handler.respond(200, resource)
            else:
                handler.respond(405, {"error": "operation_differs"})
        except (ValueError, TypeError) as error:
            handler.respond(400, {"error": str(error)})
    return True
