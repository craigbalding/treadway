#!/usr/bin/env python3
"""Bounded authoring checks and disposable reference acceptance."""
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
from urllib.parse import urlsplit

import treadway
from robot.api import ExecutionResult
from treadway.browsers import BrowserManager, BrowserSession
from treadway.browser_receipts import inspect_browser_run
from treadway.browser_runtime import BrowserRuntime
from app import make_server

ROOT = Path(__file__).resolve().parent
BROWSER = Path(treadway.__file__).parent / "browser"


def source_files():
    ignored = {"artifacts", ".git", ".venv", "venv", "node_modules", "__pycache__", ".treadway"}
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


def robot_pass_count(filename):
    total = ExecutionResult(str(filename)).statistics.total
    if not total.total or total.passed != total.total:
        raise RuntimeError('robot_acceptance_incomplete')
    return total.passed


def remote_workers_cleanup(output, *, project_id, exclude, deadline):
    """Read only this invocation's retained worker receipts; never contact a provider."""
    directories = []
    for name in ('browsers', 'actors'):
        root = output / name
        if root.is_symlink():
            return {'complete': False, 'workers': 0, 'error': 'owned_worker_root_is_symlink'}
        if root.exists():
            directories.extend(path for path in sorted(root.iterdir())
                               if path != exclude and path.name != 'state-attempts'
                               and (path.is_dir() or path.is_symlink()))
    while True:
        workers = []
        for directory in directories:
            try:
                observed = inspect_browser_run(directory, project_id=project_id, run_id=directory.name)
                complete = observed['journalComplete'] and observed['workerStoppedObserved']
                for actor in observed['actors']:
                    facts = actor['cleanup'] or {}
                    ownership_fact = {'fresh': 'contextDisposed', 'borrowed': 'attachmentDetached',
                                      'provider-session': 'profileReleased'}[actor['mode']]
                    complete = complete and facts.get('connectionClosed') is True and facts.get(ownership_fact) is True
                workers.append({'runId': directory.name, 'complete': bool(complete),
                    'unresolvedEffects': sum(len(actor['unresolvedEffects']) for actor in observed['actors'])})
            except (OSError, RuntimeError, ValueError, KeyError):
                workers.append({'runId': directory.name, 'complete': False})
        if all(worker['complete'] for worker in workers) or time.monotonic() >= deadline:
            return {'complete': all(worker['complete'] for worker in workers), 'workers': len(workers), 'runs': workers}
        time.sleep(.02)


def browser_test(output, deadline, suites, checks, *, browser_config=None, app_url=None,
                 fixture_host='127.0.0.1', fixture_port=0):
    runtime = BrowserRuntime.from_file(browser_config, root=output / 'browsers', project_root=ROOT) if browser_config else BrowserRuntime(
        output / 'browsers', project_root=ROOT)
    chrome = os.environ.get("CHROME_BIN")
    if runtime.provider == 'local' and (not chrome or not Path(chrome).is_file()):
        raise ValueError("CHROME_BIN must name an existing Chromium executable")
    if runtime.provider != 'local' and not app_url:
        raise ValueError('remote_browser_requires_app_url_reaching_this_fixture')
    if app_url:
        parsed = urlsplit(app_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
            raise ValueError('explicit_fixture_origin_required')
    server = make_server(output / "workboard.sqlite", address=(fixture_host, fixture_port))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    observer_origin = f"http://127.0.0.1:{server.server_port}"
    origin = (app_url or observer_origin).rstrip('/')
    manager = runtime
    browser = None
    try:
        options = {'executable': chrome, 'sandbox': os.environ.get('TREADWAY_CHROME_SANDBOX', 'on') != 'off'} if runtime.provider == 'local' else {}
        browser = manager.acquire("author", deadline=deadline, **options)
        config = {"origin": origin, "observerOrigin": observer_origin, "connection": browser.connection(),
                  "browserConfiguration": runtime.configuration, "projectRoot": str(runtime.project_root),
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
        tests_passed = robot_pass_count(output / "robot/output.xml")
        return {"testsPassed": tests_passed, "remainingItems": remaining, "origin": origin,
                "commandElapsedSeconds": browser_check["elapsedSeconds"]}
    finally:
        cleanup = {"complete": True, "errors": []}
        try:
            # A deadline kills Robot before its teardown can run. Actor browsers
            # have independent process groups; recover only this run's records.
            # Remote workers are run-owned: killing Robot closes its worker's
            # owner pipe. Never enumerate the provider to recover other actors.
            owned = []
            if runtime.provider == 'local':
                actors = BrowserManager(output / "actors")
                try:
                    owned.extend((actors, BrowserSession(**entry["session"])) for entry in actors.sessions())
                except (OSError, RuntimeError, ValueError) as error:
                    cleanup["complete"] = False
                    cleanup["errors"].append(str(error))
            else:
                # A dead Robot owner closes its worker's stdin. Wait only for
                # this run's private journals, never provider-wide resources.
                actor_deadline = time.monotonic() + runtime.cleanup_seconds + 2
                # The parent's acquisition bound project_id before Robot was
                # started. Never derive our expected binding from a child log.
                cleanup['actors'] = remote_workers_cleanup(output, project_id=getattr(runtime, 'project_id', None),
                    exclude=getattr(runtime, 'evidence', None), deadline=actor_deadline)
                cleanup['complete'] = cleanup['complete'] and cleanup['actors']['complete']
            for owner, session in owned:
                try:
                    owner.stop(session)
                except (OSError, RuntimeError, ValueError) as error:
                    cleanup["complete"] = False
                    cleanup["errors"].append(str(error))
            cleanup['runtime'] = runtime.close()
            cleanup['complete'] = cleanup['complete'] and cleanup['runtime']['complete']
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
    parser.add_argument('--browser-config', type=Path, help='Explicit provider configuration; check stays offline')
    parser.add_argument('--app-url', help='Browser-reachable origin of this fixture; required for remote browsers')
    parser.add_argument('--fixture-host', default='127.0.0.1', help='Explicit local fixture listen address')
    parser.add_argument('--fixture-port', type=int, default=0, help='Local fixture port (0 chooses an unused port)')
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
            summary["browser"] = browser_test(output, started + budget, suites, summary["checks"],
                browser_config=args.browser_config, app_url=args.app_url,
                fixture_host=args.fixture_host, fixture_port=args.fixture_port)
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
