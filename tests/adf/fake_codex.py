#!/usr/bin/env python3
"""Test double for the installed Codex CLI contract."""

import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import time
from uuid import uuid4


def event(kind, **fields):
    print(json.dumps({"type": kind, **fields}), flush=True)


def request(*args):
    return subprocess.check_output([sys.executable, "-m", "adf", *args], text=True).strip()


def run():
    args = sys.argv[1:]
    assert args[:4] == ["--profile", "research", "exec", "--json"]
    if "--ephemeral" in args:
        assert "ADF_TURN_ID" not in os.environ and "ADF_TURN_PROOF" not in os.environ
        command = json.loads(sys.stdin.read().splitlines()[-1])["command"]
        argv = shlex.split(command)
        detail = {"id": "item_0", "type": "command_execution", "command": command,
                  "status": "declined", "exit_code": None}
        if argv[0] == "denied":
            event("item.completed", item=detail)
            return 0
        with Path("executions").open("a") as log:
            log.write(command + "\n")
        if argv[0] == "lose-worker":
            os.kill(os.getppid(), signal.SIGKILL)
            return 0
        if argv[0] == "experiment":
            while not Path("release-experiment").exists():
                time.sleep(0.05)
        detail.update(status="completed", exit_code=3 if argv[0] == "experiment" else 0)
        event("item.completed", item=detail)
        return 0

    resume = "resume" in args
    assert args[4:] == (["resume", args[5], "-"] if resume else ["-"])
    thread = args[args.index("resume") + 1] if resume else str(uuid4())
    os.environ["CODEX_THREAD_ID"] = thread
    event("thread.started", thread_id=thread)
    prompt = sys.stdin.read()
    history = Path(f"context-{thread}")

    if resume:
        original = history.read_text()
        event("context", original=original, prompt=prompt)
        if original == "declined":
            assert "declined the requested command" in prompt
        elif original == "fail-continuation":
            return 7
        elif not Path("second-request").exists():
            Path("second-request").touch()
            request("run-and-resume", '["quick", "--seed", "42"]')
        else:
            request("spawn", "fresh instruction")
    else:
        assert not history.exists()
        history.write_text(prompt)
        if prompt == "start":
            argv = '["experiment"]'
            job = request("run-and-resume", argv)
            assert request("run-and-resume", argv) == job
            duplicate = subprocess.run(
                [sys.executable, "-m", "adf", "spawn", "conflicting request"],
                capture_output=True, text=True,
            )
            assert duplicate.returncode == 1 and "already registered" in duplicate.stderr
            event("accepted", id=job)
            Path("source-accepted").touch()
            while not Path("release-source").exists():
                time.sleep(0.05)
        elif prompt == "spawn only":
            request("spawn", "fresh without experiments")
        elif prompt == "fresh instruction":
            Path("fresh-running").touch()
            while not Path("release-fresh").exists():
                time.sleep(0.05)
        elif prompt == "fail-continuation":
            request("run-and-resume", '["quick"]')
        elif prompt == "lose-worker":
            request("run-and-resume", '["lose-worker"]')
        elif prompt == "declined":
            request("run-and-resume", '["denied"]')
        elif prompt == "unauthorized":
            failure = subprocess.run(
                [sys.executable, "-m", "adf", "run-and-resume", '["unapproved"]'],
                capture_output=True, text=True,
            )
            assert failure.returncode == 1 and "--enable-experiments" in failure.stderr
    event("turn.completed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
