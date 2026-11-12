"""Check the actual release archives against the intended runtime assets."""
import hashlib
from pathlib import Path
import tarfile
import zipfile

root = Path(__file__).resolve().parents[2]
dist = root / "dist"
wheel, = dist.glob("*.whl")
sdist, = dist.glob("*.tar.gz")
package = root / "src/treadway"
expected = {str(file.relative_to(package.parent)): file.read_bytes()
            for file in package.rglob("*") if file.is_file()
            and not any(part in {"__pycache__", "node_modules"} for part in file.parts)
            and file.suffix not in {".pyc", ".pyo"}}
with zipfile.ZipFile(wheel) as archive:
    actual = {name: archive.read(name) for name in archive.namelist()
              if name.startswith("treadway/") and not name.endswith("/")}
    assert actual == expected, "Wheel package content differs from source assets"
with tarfile.open(sdist) as archive:
    members = {member.name.partition("/")[2]: member for member in archive.getmembers() if member.isfile()}
    for name, content in expected.items():
        assert archive.extractfile(members[f"src/{name}"]).read() == content, name
    for name in ("README.md", "pyproject.toml", "package-lock.json", "docs/EXAMPLES.md",
                 "tests/browser-fixture.js", "tests/fixtures/widgets/vue.js", "scripts/preflight.py"):
        assert name in members, f"Source archive missing {name}"
    assert not any(part in {"node_modules", ".env", "artifacts", ".git"}
                   for name in members for part in Path(name).parts), "Unexpected private/runtime files"
checksums = "".join(f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n"
                    for file in sorted((wheel, sdist)))
(dist / "SHA256SUMS").write_text(checksums)
print(f"Verified {len(expected)} package assets in wheel and source archive")
