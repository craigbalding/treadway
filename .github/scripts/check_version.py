"""Reject inconsistent package versions and mismatching release tags."""
import ast
import json
from pathlib import Path
import re
import sys
import tomllib

root = Path(__file__).resolve().parents[2]
version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit("Expected a three-component release version")
tree = ast.parse((root / "src/treadway/__init__.py").read_text())
python_version = next(ast.literal_eval(node.value) for node in tree.body
                      if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "__version__"
                              for target in node.targets))
assert python_version == version, "Python version differs"
for directory in (root, root / "src/treadway/browser"):
    package = json.loads((directory / "package.json").read_text())
    lock = json.loads((directory / "package-lock.json").read_text())
    assert package["version"] == lock["version"] == lock["packages"][""]["version"] == version, directory
if len(sys.argv) > 1:
    assert sys.argv[1] == f"v{version}", "Tag must match the package version exactly"
print(version)
