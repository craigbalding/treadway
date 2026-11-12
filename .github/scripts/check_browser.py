"""Fail early with Chrome's own startup diagnostics on the disposable CI runner."""
import os
from pathlib import Path
import tempfile

from treadway.browsers import BrowserManager

root = Path(tempfile.mkdtemp(prefix="treadway-browser-check-"))
manager = BrowserManager(root)
session = None
try:
    session = manager.start("check", executable=os.environ["CHROME_BIN"], sandbox=True)
    print("Sandboxed Chrome startup passed.")
except Exception:
    for log in root.rglob("chrome-*.log"):
        print(f"Chrome startup log ({log}):", flush=True)
        print(log.read_text(errors="replace")[-16000:], flush=True)
    raise
finally:
    if session is not None:
        manager.stop(session)
