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


def profile(root, *, inbox):
    filesystem = {str(root / "adf"): "read", str(root / ".git"): "read",
                  str(root / ".codex"): "read", str(root / ".agents"): "read"}
    if inbox:
        filesystem[str(root / "adf/queue/requests")] = "write"
    return [
        "-c", 'permissions.adf.extends=":workspace"',
        "-c", 'permissions.adf.filesystem=' + toml_paths(filesystem),
        "-c", "permissions.adf.network.enabled=false",
        "-c", 'default_permissions="adf"',
    ]


def toml_paths(paths):
    return "{ " + ", ".join(f"{json.dumps(key)} = {json.dumps(value)}"
                             for key, value in paths.items()) + " }"


def codex_environment(turn_id, token):
    env = os.environ.copy()
    env.pop("CODEX_THREAD_ID", None)
    env["ADF_TURN_ID"] = turn_id
    env["ADF_TURN_PROOF"] = token
    return env


def codex_turn(root, codex, directory, token, prompt, output, thread=None):
    args = [codex, "exec", *profile(root, inbox=True),
            "-c", 'approval_policy="never"', "--json"]
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
                env=codex_environment(directory.name, token),
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


def new_turn(queue, turn_id=None):
    directory = queue / "turns" / (turn_id or str(uuid4()))
    token = secrets.token_hex(32)
    # Publish the directory only after its lease is held.
    with tempfile.TemporaryDirectory(dir=directory.parent) as temp:
        staging = Path(temp) / "turn"
        staging.mkdir(mode=0o700)
        atomic_json(staging / "token-hash.json", token_hash(token))
        lease = lock(staging / "lock")
        try:
            staging.rename(directory)
        except OSError:
            lease.close()
            raise
    return directory, lease, token


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def experiment(root, codex, argv, directory):
    env = {key: os.environ[key] for key in ("PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL")
           if key in os.environ}
    with (directory / "experiment.log").open("ab", buffering=0) as log:
        try:
            outcome = subprocess.run(
                [codex, "sandbox", "--include-managed-config", *profile(root, inbox=False),
                 "-P", "adf", "--", *argv], cwd=root, env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            )
            result = {"exit_code": outcome.returncode}
        except OSError as exc:
            result = {"exit_code": None, "error": str(exc)}
    result["finished_at"] = time.time()
    atomic_json(directory / "result.json", result)
