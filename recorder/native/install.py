#!/usr/bin/env python3
"""Install a user-owned native host for one explicitly supplied extension ID."""
import argparse
import json
import re
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("extension_id")
    parser.add_argument("--browser", choices=["chromium", "google-chrome"], default="chromium")
    args = parser.parse_args()
    if not re.fullmatch("[a-p]{32}", args.extension_id):
        parser.error("Use the installed extension's exact 32-character ID")
    location = Path.home() / ".local/share/treadway-recorder/native"
    location.mkdir(parents=True, exist_ok=True)
    host = location / "safeyolo_host.py"
    shutil.copyfile(Path(__file__).with_name("safeyolo_host.py"), host)
    host.chmod(0o700)
    manifests = Path.home() / ".config" / args.browser / "NativeMessagingHosts"
    manifests.mkdir(parents=True, exist_ok=True)
    target = manifests / "com.treadway.safeyolo.json"
    target.write_text(json.dumps({"name": "com.treadway.safeyolo", "description": "Optional SafeYolo recording context integration",
                                 "path": str(host), "type": "stdio", "allowed_origins": [f"chrome-extension://{args.extension_id}/"]}, indent=2) + "\n")
    print("Installed native host for the supplied extension ID")


if __name__ == "__main__":
    main()
