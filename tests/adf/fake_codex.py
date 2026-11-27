#!/usr/bin/env python3
"""Test double for the installed Codex CLI contract."""

import json
import os
from pathlib import Path
import signal
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
    if args[0] == "sandbox":
        command = args[args.index("--") + 1:]
        with Path("executions").open("a") as log:
            log.write(command[0] + "\n")
        print("experiment output", flush=True)
        if command[0] == "lose-worker":
            os.kill(os.getppid(), signal.SIGKILL)
            return 0
        if command[0] == "experiment":
            while not Path("release-experiment").exists():
                time.sleep(0.05)
        return 3 if command[0] == "experiment" else 0

    resume = "resume" in args
    thread = args[args.index("resume") + 1] if resume else str(uuid4())
    os.environ["CODEX_THREAD_ID"] = thread
    event("thread.started", thread_id=thread)
    prompt = sys.stdin.read()
    history = Path(f"context-{thread}")

    if resume:
        original = history.read_text()
        event("context", original=original, prompt=prompt)
        if original == "fail-continuation":
            return 7
        if not Path("second-request").exists():
            Path("second-request").touch()
            request("run-and-resume", '["quick"]')
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
        elif prompt == "fresh instruction":
            Path("fresh-running").touch()
            while not Path("release-fresh").exists():
                time.sleep(0.05)
        elif prompt == "fail-continuation":
            request("run-and-resume", '["quick"]')
        elif prompt == "lose-worker":
            request("run-and-resume", '["lose-worker"]')
        elif prompt == "unauthorized":
            failure = subprocess.run(
                [sys.executable, "-m", "adf", "run-and-resume", '["unapproved"]'],
                capture_output=True, text=True,
            )
            assert failure.returncode == 1 and "operator-authorized" in failure.stderr
    event("turn.completed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
