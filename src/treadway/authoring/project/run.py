#!/usr/bin/env python3
"""Bounded local authoring checks and disposable reference acceptance."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET

import treadway
from treadway.browsers import BrowserManager, BrowserSession
from app import make_server

ROOT = Path(__file__).resolve().parent
BROWSER = Path(treadway.__file__).parent / "browser"


def source_files():
    ignored = {"artifacts", ".git", ".venv", "venv", "node_modules", "__pycache__"}
    for directory, names, files in os.walk(ROOT):
        names[:] = sorted(name for name in names if name not in ignored)
        for name in sorted(files):
            file = Path(directory) / name
            if file.suffix in {".py", ".js", ".cjs", ".mjs", ".html", ".robot", ".md", ".json"}:
                yield file


def command(arguments, output, name, deadline, *, env=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("overall_feedback_deadline")
    start = time.monotonic()
    with (output / (name + ".log")).open("w") as stream:
        process = subprocess.Popen(arguments, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
        try:
            code = process.wait(timeout=remaining)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
            raise
    elapsed = round(time.monotonic() - start, 3)
    print(f"{'PASS' if code == 0 else 'FAIL'} {name} {elapsed}s: {output / (name + '.log')}", flush=True)
    return {"name": name, "passed": code == 0, "exitCode": code,
            "status": "passed" if code == 0 else "failed", "elapsedSeconds": elapsed,
            "log": str(output / (name + ".log"))}


def checked(arguments, output, name, deadline, checks, *, env=None):
    started = time.monotonic()
    try:
        entry = command(arguments, output, name, deadline, env=env)
    except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
        checks.append({"name": name, "passed": False, "status": "incomplete",
                       "exitCode": None, "elapsedSeconds": round(time.monotonic() - started, 3),
                       "log": str(output / (name + ".log")), "error": str(error)})
        raise
    checks.append(entry)
    if not entry["passed"]:
        raise RuntimeError(f"{name} failed; inspect {entry['log']}")
    return entry


def offline(output, deadline, checks):
    env = dict(os.environ)
    env.pop("TREADWAY_REFERENCE_CONFIG", None)
    env.pop("ROBOT_OPTIONS", None)
    sources = list(source_files())
    javascript = [str(file) for file in sources if file.suffix in {".js", ".cjs", ".mjs"}]
    python = [str(file) for file in sources if file.suffix == ".py"]
    node_contracts = [str(file) for file in sources if file.relative_to(ROOT).parts[0] == "tests"
                      and file.suffix in {".js", ".cjs", ".mjs"}
                      and (".test." in file.name or file.name.startswith("test_"))]
    if not node_contracts:
        raise ValueError("At least one Node contract in tests/ is required")
    commands = [
        ("python-syntax", [sys.executable, "-m", "py_compile", *python]),
        ("python-contracts", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
        ("adapter-contracts", ["node", "--test", *node_contracts]),
        ("javascript-syntax", ["node", "-e", "for(const file of process.argv.slice(1)) require('node:child_process').execFileSync(process.execPath,['--check',file],{stdio:'inherit'});", *javascript]),
        ("robot-structure", [sys.executable, "-m", "robot", "--dryrun", "--pythonpath", str(ROOT),
                             "--outputdir", str(output / "dryrun"), "--log", "NONE", "--report", "NONE",
                             *[str(file) for file in sorted(ROOT.glob("*.robot"))]]),
    ]
    for name, args in commands:
        checked(args, output, name, deadline, checks, env=env)
    return checks


def browser_test(output, deadline, suites, checks):
    chrome = os.environ.get("CHROME_BIN")
    if not chrome or not Path(chrome).is_file():
        raise ValueError("CHROME_BIN must name an existing Chromium executable")
    server = make_server(output / "workboard.sqlite")
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    manager = BrowserManager(output / "browsers")
    browser = None
    try:
        browser = manager.start("author", executable=chrome,
                                sandbox=os.environ.get("TREADWAY_CHROME_SANDBOX", "on") != "off",
                                startup_seconds=min(8, max(.01, deadline-time.monotonic())))
        config = {"origin": origin, "cdpPort": browser.port, "targetId": browser.target_id,
                  "browserRoot": str(BROWSER), "artifacts": str(output), "run": uuid.uuid4().hex}
        config_file = output / "runtime.json"
        config_file.write_text(json.dumps(config))
        env = {**os.environ, "TREADWAY_REFERENCE_CONFIG": str(config_file)}
        # Local fixture credentials only. Real adapters provision these through
        # their selected provider; source configuration contains references.
        env.update({"TREADWAY_FIXTURE_CASEY_USERNAME": "casey", "TREADWAY_FIXTURE_SAM_USERNAME": "sam",
                    "TREADWAY_FIXTURE_CASEY_PASSWORD": "synthetic-only",
                    "TREADWAY_FIXTURE_SAM_PASSWORD": "synthetic-only"})
        env.pop("ROBOT_OPTIONS", None)
        browser_check = checked([sys.executable, "-m", "robot", "--pythonpath", str(ROOT), "--outputdir", str(output / "robot"),
                 *[str(file) for file in suites]], output, "browser-flow", deadline, checks, env=env)
        with sqlite3.connect(output / "workboard.sqlite") as db:
            remaining = db.execute("SELECT count(*) FROM items").fetchone()[0]
        if remaining:
            raise RuntimeError("scoped_cleanup_incomplete")
        report = ET.parse(output / "robot/output.xml")
        tests = report.findall(".//test")
        if not tests or any(test.find("status").get("status") != "PASS" for test in tests):
            raise RuntimeError("robot_acceptance_incomplete")
        return {"testsPassed": len(tests), "remainingItems": remaining, "origin": origin,
                "commandElapsedSeconds": browser_check["elapsedSeconds"]}
    finally:
        cleanup = {"complete": True, "errors": []}
        try:
            # A deadline kills Robot before its teardown can run. Actor browsers
            # have independent process groups; recover only this run's records.
            actors = BrowserManager(output / "actors")
            owned = [(manager, browser)] if browser is not None else []
            try:
                owned.extend((actors, BrowserSession(**entry["session"])) for entry in actors.sessions())
            except (OSError, RuntimeError, ValueError) as error:
                cleanup["complete"] = False
                cleanup["errors"].append(str(error))
            for owner, session in owned:
                try:
                    owner.stop(session)
                except (OSError, RuntimeError, ValueError) as error:
                    cleanup["complete"] = False
                    cleanup["errors"].append(str(error))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)
            (output / "browser-cleanup.json").write_text(json.dumps(cleanup))
        if not cleanup["complete"]:
            raise RuntimeError("owned_browser_cleanup_incomplete; inspect browser-cleanup.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "test"])
    parser.add_argument("--suite", action="append", type=Path, help="Explicit Robot suite; defaults to flow.robot")
    parser.add_argument("--budget-seconds", type=float, default=None)
    args = parser.parse_args()
    budget = args.budget_seconds if args.budget_seconds is not None else (15 if args.mode == "check" else 60)
    if not 1 <= budget <= 120:
        parser.error("budget must be between 1 and 120 seconds")
    os.umask(0o077)
    output = ROOT / "artifacts" / (args.mode + "-" + uuid.uuid4().hex)
    output.mkdir(parents=True, mode=0o700)
    started = time.monotonic()
    summary = {"passed": False, "mode": args.mode, "budgetSeconds": budget,
               "liveConditionsVerified": False, "checks": [], "artifacts": str(output)}
    sources = {str(file.relative_to(ROOT)): hashlib.sha256(file.read_bytes()).hexdigest()
               for file in source_files()}
    (output / "sources.json").write_text(json.dumps(sources, indent=2))
    try:
        offline(output, started + budget, summary["checks"])
        if args.mode == "test":
            suites = [file.resolve() for file in (args.suite or [ROOT / "flow.robot"])]
            summary["browser"] = browser_test(output, started + budget, suites, summary["checks"])
            summary["liveConditionsVerified"] = True
        summary["passed"] = True
    except (OSError, RuntimeError, ValueError, TimeoutError, subprocess.SubprocessError) as error:
        summary["error"] = str(error)
        print(f"FAIL {error}", flush=True)
    finally:
        summary["elapsedSeconds"] = round(time.monotonic() - started, 3)
        (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary), flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
