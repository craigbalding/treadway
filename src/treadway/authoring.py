"""Export the installed flow-authoring kit without connecting to a browser."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import tempfile

ASSETS = Path(__file__).with_name("authoring")


def copy_new(source: Path, destination: Path):
    """Stage a complete tree and never merge into or overwrite an existing path."""
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"Destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".treadway-", dir=destination.parent))
    try:
        shutil.copytree(source, staging, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        # Rename only after all assets have been copied. The destination must be new.
        if destination.exists() or destination.is_symlink():
            raise ValueError(f"Destination already exists: {destination}")
        staging.rename(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    new = commands.add_parser("new", help="Create a runnable local reference flow")
    new.add_argument("destination", type=Path)
    skill = commands.add_parser("skill", help="Export the self-contained agent skill")
    skill.add_argument("destination", type=Path,
                       help="New skill folder, e.g. ~/.codex/skills/treadway-flows")
    guide = commands.add_parser("guide", help="Print an installed authoring reference")
    guide.add_argument("topic", nargs="?", choices=["start", "recipes", "walkthrough", "sessions", "credentials", "entra"], default="start")
    args = parser.parse_args(argv)
    try:
        if args.command == "guide":
            filename = {"start": "AUTHORING.md", "recipes": "RECIPES.md",
                        "walkthrough": "WALKTHROUGH.md", "sessions": "SESSIONS.md",
                        "credentials": "CREDENTIALS.md", "entra": "ENTRA.md"}[args.topic]
            print((ASSETS / "skill/treadway-flows/references" / filename).read_text())
        elif args.command == "skill":
            print(copy_new(ASSETS / "skill/treadway-flows", args.destination))
        else:
            result = copy_new(ASSETS / "project", args.destination)
            copy_new(ASSETS / "skill/treadway-flows",
                     result / ".agents/skills/treadway-flows")
            print(f"Created {result}\nNext: cd {result}\npython run.py check\n"
                  "CHROME_BIN=/absolute/path/to/chromium python run.py test")
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
