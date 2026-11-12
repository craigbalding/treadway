#!/usr/bin/env python3
"""Check explicit execution sources; this does not execute a workflow.

Robot dry-run imports libraries/constructors: those must be free of target actions.
Application fault tests and generated-expression checks run separately, explicitly.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path,
                        help="Explicit .py, .js/.cjs/.mjs and .robot files; no directory scan")
    parser.add_argument("--outputdir", required=True, type=Path)
    parser.add_argument("--pythonpath", action="append", default=[])
    parser.add_argument("--variable", action="append", default=[],
                        help="Robot NAME:value; use non-secret configuration only")
    parser.add_argument("--timeout", type=float, default=60,
                        help="Deadline per check, in seconds")
    args = parser.parse_args()
    if not 0 < args.timeout <= 600:
        parser.error("--timeout must be greater than zero and at most 600 seconds")
    files = list(dict.fromkeys(path.resolve() for path in args.files))
    for path in files:
        if not path.is_file() or path.suffix not in {".py", ".js", ".cjs", ".mjs", ".robot"}:
            parser.error(f"Not a supported source file: {path}")
    output = args.outputdir.resolve()
    # Preserve previous check evidence instead of quietly overwriting it.
    output.mkdir(parents=True, exist_ok=False)
    checks = []

    def run(name, command, *, env=None):
        log = output / f"{len(checks) + 1:02d}-{name}.log"
        print(f"CHECK {name}", flush=True)
        with log.open("w") as stream:
            try:
                result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT,
                                        timeout=args.timeout, check=False, env=env)
                code = result.returncode
                status = "passed" if code == 0 else "failed"
            except (OSError, subprocess.TimeoutExpired) as error:
                stream.write(f"\n{type(error).__name__}: {error}\n")
                code, status = None, "incomplete"
        checks.append({"name": name, "status": status, "exitCode": code, "log": str(log)})
        print(f"{status.upper()} {name}: {log}", flush=True)

    python = [str(path) for path in files if path.suffix == ".py"]
    if python:
        run("python-errors", [sys.executable, "-m", "ruff", "check", "--no-fix", "--no-cache",
                              "--config", str(ROOT / "robot-ruff.toml"), *python])
    for i, path in enumerate(path for path in files if path.suffix in {".js", ".cjs", ".mjs"}):
        run(f"node-syntax-{i}", ["node", "--check", str(path)])
    suites = [str(path) for path in files if path.suffix == ".robot"]
    if suites:
        command = [sys.executable, "-m", "robot", "--dryrun", "--exitonerror", "--statusrc",
                   "--outputdir", str(output / "robot"),
                   "--log", "NONE", "--report", "NONE"]
        for path in args.pythonpath:
            command.extend(["--pythonpath", path])
        for value in args.variable:
            command.extend(["--variable", value])
        # Avoid hidden inherited selection/listener/return-code settings in this check.
        # Proxy and CA variables, and normal Python import paths, remain intact.
        robot_env = dict(os.environ)
        robot_env.pop("ROBOT_OPTIONS", None)
        run("robot-structure", [*command, *suites], env=robot_env)
    passed = bool(checks) and all(check["status"] == "passed" for check in checks)
    summary = {"structuralChecksPassed": passed, "files": [str(path) for path in files],
               "checks": checks, "liveConditionsVerified": False,
               "outcome": "not_evaluated"}
    (output / "preflight.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
