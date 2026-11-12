"""Bounded JSON subprocess transport with live stderr delivery; no app verdicts."""
from __future__ import annotations

import json
import math
import os
import signal
import queue
import subprocess
import threading
import time


class JsonProcessIncomplete(RuntimeError):
    """A failed runner cannot supply a trusted completion; payload stays available."""
    def __init__(self, result):
        self.result = result
        super().__init__(f"JSON process incomplete: failure={result.get('failure')} exit={result.get('exitCode')}")


def require_completed_process(result):
    """Return the payload only after runner completion; preserve failures on error.

    This guard establishes runner completion. Application behavior requires its
    own observations. Analyse effects from exception.result without labelling the
    incomplete workflow successful or retrying the action automatically.
    """
    if result.get("failure") is not None or result.get("exitCode") != 0:
        raise JsonProcessIncomplete(result)
    return result["payload"]


def run_json_process(command, *, input_data=None, timeout_seconds=65, on_stderr=None,
                     preserve_newlines=False):
    """Return payload, exitCode, failure and stderrLines without hiding failures.

    Each pipe has one reader. Callbacks run in the calling thread while the
    child is alive; do not use communicate() alongside a stderr pump. The
    deadline includes stdin writing and waiting after output streams close.
    On POSIX a timeout kills the process group, including pipe-holding children;
    it cannot cancel a browser action already dispatched.
    Callback code must itself be bounded. This transport makes no claim about
    account identity, application prerequisites or workflow completion.
    ``preserve_newlines=True`` decodes output as UTF-8 without translating CRLF
    or bare CR; this is useful for a private helper returning exact text.
    """
    if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds) or timeout_seconds <= 0):
        raise ValueError("timeout_seconds must be positive")
    if input_data is not None and not isinstance(input_data, str):
        raise TypeError("input_data must be a string or None")
    started = time.monotonic()
    result = {"payload": None, "exitCode": None, "failure": None,
              "stderrLines": [], "progressErrors": []}
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=os.name == "posix")
    except OSError as error:
        result["failure"] = "process_start_failed"
        result["errorType"] = type(error).__name__
        return result
    if preserve_newlines:
        for stream in (process.stdout, process.stderr):
            stream.reconfigure(encoding='utf-8', newline='')
    received = queue.Queue()

    def pump(stream, name):
        try:
            for line in stream:
                received.put((name, line))
        except (OSError, ValueError, UnicodeError):
            received.put(("pipe_error", name))
        finally:
            received.put((name, None))

    def write_input():
        try:
            if input_data is not None:
                process.stdin.write(input_data)
        except (OSError, ValueError, UnicodeError):
            received.put(("input_error", None))
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    threads = [threading.Thread(target=pump, args=(stream, name), daemon=True)
               for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr"))]
    threads.append(threading.Thread(target=write_input, daemon=True))
    for thread in threads:
        thread.start()
    output, closed = [], set()
    try:
        while len(closed) < 2:
            remaining = timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                result["failure"] = "process_deadline"
                break
            try:
                name, line = received.get(timeout=min(remaining, 0.1))
            except queue.Empty:
                continue
            if name in ("input_error", "pipe_error"):
                result["failure"] = name
            elif line is None:
                closed.add(name)
            elif name == "stdout":
                output.append(line)
            else:
                result["stderrLines"].append(line.rstrip("\n"))
                if on_stderr is not None:
                    try:
                        on_stderr(line.rstrip("\n"))
                    except Exception as error:
                        result["progressErrors"].append(type(error).__name__)
        if result["failure"] != "process_deadline":
            remaining = max(0.001, timeout_seconds - (time.monotonic() - started))
            try:
                process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                result["failure"] = "process_deadline"
    finally:
        if os.name == "posix" and (process.poll() is None or result["failure"] == "process_deadline"):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        for thread in threads:
            thread.join(timeout=0.2)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
    # Readers may enqueue a final buffered chunk while the process is killed.
    while not received.empty():
        name, line = received.get_nowait()
        if name == "stdout" and line is not None:
            output.append(line)
        elif name == "stderr" and line is not None:
            result["stderrLines"].append(line.rstrip("\n"))
        elif name in ("pipe_error", "input_error"):
            result["failure"] = result["failure"] or name
    result["stdout"] = "".join(output)
    result["exitCode"] = process.returncode
    try:
        result["payload"] = json.loads("".join(output))
    except (ValueError, TypeError):
        result["failure"] = result["failure"] or "invalid_json_output"
    if process.returncode != 0:
        result["failure"] = result["failure"] or "nonzero_exit"
    return result
