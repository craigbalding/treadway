"""Real first-pass checks against good/broken sources; no target traffic.

Use an interpreter with the project development dependencies installed.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
READY = (shutil.which("node") is not None and
         all(importlib.util.find_spec(name) for name in ("ruff", "robot")))


@unittest.skipUnless(READY, "requires Node and project development dependencies")
class PreflightChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.home())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self, name, contents):
        path = self.root / name
        path.write_text(contents)
        return path

    def run_check(self, *files, env=None):
        output = self.root / "checks"
        result = subprocess.run([sys.executable, str(ROOT / "scripts/preflight.py"),
                                 *map(str, files), "--outputdir", str(output)],
                                capture_output=True, text=True, timeout=30, env=env)
        return result, json.loads((output / "preflight.json").read_text())

    def test_good_sources_dry_run_does_not_execute_library_keyword(self):
        marker = self.root / "must-not-run"
        library = self.source("Safe.py", "from pathlib import Path\nclass Safe:\n"
                              "    def touch_target(self, value):\n"
                              f"        Path({str(marker)!r}).write_text(value)\n")
        js = self.source("safe.js", "module.exports = value => value;\n")
        suite = self.source("safe.robot", f"*** Settings ***\nLibrary    {library}\n"
                            "*** Test Cases ***\nExample\n    Touch Target    value\n")
        result, summary = self.run_check(library, js, suite)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(summary["structuralChecksPassed"])
        self.assertFalse(summary["liveConditionsVerified"])
        self.assertEqual(summary["outcome"], "not_evaluated")
        self.assertFalse(marker.exists())
        self.assertTrue((self.root / "checks/robot/output.xml").is_file())

    def test_undefined_python_name_fails_even_though_python_compiles(self):
        source = "def evaluate():\n    return invented_result\n"
        compile(source, "bad.py", "exec")
        result, summary = self.run_check(self.source("bad.py", source))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary["structuralChecksPassed"])
        self.assertIn("F821", Path(summary["checks"][0]["log"]).read_text())

    def test_invalid_outer_javascript_fails(self):
        result, summary = self.run_check(self.source("bad.js", "const value = ;\n"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(summary["checks"][0]["status"], "failed")

    def test_missing_keyword_fails(self):
        suite = self.source("bad.robot", "*** Test Cases ***\nExample\n"
                            "    Invented Operation\n")
        result, summary = self.run_check(suite)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary["structuralChecksPassed"])

    def test_wrong_keyword_argument_count_fails(self):
        suite = self.source("bad.robot", "*** Test Cases ***\nExample\n    Log\n")
        result, summary = self.run_check(suite)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary["structuralChecksPassed"])

    def test_missing_library_fails(self):
        suite = self.source("bad.robot", "*** Settings ***\n"
                            "Library    NoSuchExecutionLibrary\n"
                            "*** Test Cases ***\nExample\n    No Operation\n")
        result, summary = self.run_check(suite)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary["structuralChecksPassed"])

    def test_inherited_robot_options_cannot_hide_a_failure(self):
        suite = self.source("bad.robot", "*** Test Cases ***\nExample\n"
                            "    Invented Operation\n")
        env = dict(os.environ, ROBOT_OPTIONS="--nostatusrc")
        result, summary = self.run_check(suite, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary["structuralChecksPassed"])

    def test_missing_node_is_incomplete_not_success(self):
        env = dict(os.environ, PATH="")
        result, summary = self.run_check(self.source("safe.js", "'use strict';\n"), env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(summary["checks"][0]["status"], "incomplete")
        self.assertFalse(summary["structuralChecksPassed"])

    def test_outer_syntax_success_does_not_validate_generated_expression(self):
        module = self.source("generated.js", "exports.build = () => 'const value = ;';\n")
        result, summary = self.run_check(module)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(summary["structuralChecksPassed"])
        expression_check = subprocess.run(
            ["node", "-e", "new (require('node:vm').Script)(require(process.argv[1]).build());",
             str(module)], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(expression_check.returncode, 0)
        self.assertIn("SyntaxError", expression_check.stderr)


if __name__ == "__main__":
    unittest.main()
