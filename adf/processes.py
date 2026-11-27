"""Codex CLI integration and durable evidence of child process completion."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from uuid import uuid4

from .ipc_support import atomic_json, is_id


def lock(path, *, blocking=False):
    handle = path.open("ab")
    try:
        mode = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
        fcntl.flock(handle, mode)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def receipt(directory):
    """None while active, a result on exit, or an explicit uncertain result."""
    path = directory / "result.json"
    if path.exists():
        return json.loads(path.read_text())
    if not directory.is_dir():
        return {"error": "missing process record"}
    with (directory / "lock").open("rb") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return None
        if path.exists():
            return json.loads(path.read_text())
        return {"error": "process ended without a completion receipt"}


def codex_args(settings):
    args = [settings["codex"]]
    if settings["profile"] is not None:
        args += ["--profile", settings["profile"]]
    return [*args, "exec", "--json"]


def codex_home():
    return str(Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").resolve())


def codex_environment(settings, turn_id=None, token=None):
    env = os.environ.copy()
    env.pop("CODEX_THREAD_ID", None)
    env.pop("ADF_TURN_ID", None)
    env.pop("ADF_TURN_PROOF", None)
    env["CODEX_HOME"] = settings["home"]
    if turn_id is not None:
        env["ADF_TURN_ID"] = turn_id
        env["ADF_TURN_PROOF"] = token
    return env


def codex_turn(root, settings, directory, token, prompt, output, thread=None):
    args = codex_args(settings)
    if thread:
        args += ["resume", thread]
    args += ["-"]
    actual_thread = None
    try:
        # Use a file so uploading the prompt and draining JSONL cannot deadlock.
        with tempfile.TemporaryFile() as source:
            source.write(prompt.encode())
            source.seek(0)
            with subprocess.Popen(
                args, cwd=root, stdin=source, stdout=subprocess.PIPE,
                env=codex_environment(settings, directory.name, token),
            ) as child:
                for line in child.stdout:
                    try:
                        event = json.loads(line)
                        if event.get("type") == "thread.started" and is_id(event.get("thread_id")):
                            actual_thread = event["thread_id"]
                    except (ValueError, AttributeError):
                        pass
                    output.write(line)
                    output.flush()
                code = child.wait()
        result = {"exit_code": code, "thread_id": actual_thread}
        if not actual_thread or (thread and actual_thread != thread):
            result["error"] = "Codex did not confirm the expected thread via thread.started"
    except OSError as exc:
        result = {"error": str(exc)}
    result["finished_at"] = time.time()
    atomic_json(directory / "result.json", result)
    return result


def new_turn(queue, settings, turn_id=None):
    directory = queue / "turns" / (turn_id or str(uuid4()))
    token = secrets.token_hex(32)
    # Publish the directory only after its lease is held.
    with tempfile.TemporaryDirectory(dir=directory.parent) as temp:
        staging = Path(temp) / "turn"
        staging.mkdir(mode=0o700)
        atomic_json(staging / "token-hash.json", token_hash(token))
        atomic_json(staging / "settings.json", settings)
        lease = lock(staging / "lock")
        try:
            staging.rename(directory)
        except OSError:
            lease.close()
            raise
    return directory, lease, token


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()
