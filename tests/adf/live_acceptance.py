"""Opt-in test of the official Codex CLI with real inference; no GitHub calls."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

SOURCE = Path(__file__).resolve().parents[2]
SUCCESS = ["python3", "trial.py", "4"]
FAILURE = ["python3", "trial.py", "7"]


def invoke(root, *args):
    return subprocess.check_output(
        [sys.executable, "-m", "adf", *args], cwd=root, text=True, timeout=90
    )


def jobs(root):
    return json.loads(invoke(root, "status"))["jobs"]


def request(command):
    return "python3 -m adf run-and-resume '" + json.dumps(command).replace("'", "'\"'\"'") + "'"


def main(root, profile):
    subprocess.run(["git", "init", "-q", str(root)], check=True, timeout=10)
    shutil.copytree(SOURCE / "adf", root / "adf",
                    ignore=shutil.ignore_patterns("runtime", "queue", "requests", "__pycache__"))
    shutil.copytree(SOURCE / ".agents/skills", root / ".agents/skills")
    shutil.copyfile(SOURCE / "AGENTS.md", root / "AGENTS.md")
    daemon = start_daemon(root, profile)
    try:
        queue = root / ".codex/adf"
        deadline = time.monotonic() + 5
        while not (queue / "settings.json").exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("ADF did not start")
            time.sleep(0.1)
        assert jobs(root) == [] and not list((queue / "turns").iterdir())
        print("PASS independent startup", flush=True)

        marker = "ADF-CONTEXT-" + uuid4().hex
        prompt = f"""
This is a bounded ADF acceptance test. Use the command tool for the steps below.
Remember this exact context marker across both continuations: {marker}
First, verify these paths cannot be written from your tool sandbox by running
  if touch .codex/adf/forbidden 2>/dev/null; then exit 1; fi
Create trial.py in this repository. It should take one number from argv.
Append the number to a workspace file named trial-runs.txt and close it before sleeping.
For number 4, first use pathlib to try writing .codex/adf/experiment-forbidden.
If that write fails with PermissionError, print and flush ADF-SANDBOX-PROTECTED.
Then print and flush ADF-experiment-one, sleep 15 seconds, and exit 0.
For number 7, print and flush ADF-experiment-two and exit 7.
Then run exactly this ADF registration command and after a job ID is returned end your turn immediately:
  {request(SUCCESS)}

When ADF resumes you with exit code 0, use the conversation history to recall the marker.
Run exactly this command once and after a job ID is returned end your turn, reporting the marker verbatim:
  {request(FAILURE)}

When resumed with exit code 7, recall the same marker and report it verbatim in your final answer.
First run exactly:
  python3 -m adf spawn 'Reply with exactly FRESH-A-C-F-OK. Use no tools, submit no requests, and end your turn.'
Never spawn at another point. No other work is needed.
"""
        initial = invoke(root, "session", prompt)
        initial_events = [json.loads(line) for line in initial.splitlines()]
        thread = next(event["thread_id"] for event in initial_events if event["type"] == "thread.started")
        assert not (queue / "forbidden").exists()
        assert "touch .codex/adf/forbidden" in initial
        source_job = jobs(root)[0]
        experiment_log = queue / "jobs" / source_job["id"] / "experiment.log"
        trial_runs = root / "trial-runs.txt"
        deadline = time.monotonic() + 65
        while not trial_runs.exists() or "4" not in trial_runs.read_text():
            if time.monotonic() >= deadline or jobs(root)[0]["state"] == "done":
                log = experiment_log.read_text(errors="replace") if experiment_log.exists() else ""
                raise RuntimeError(f"detached experiment did not start: {jobs(root)}\n{log[-5000:]}")
            time.sleep(0.1)
        assert jobs(root)[0]["state"] == "experiment"
        daemon.kill()
        daemon.wait(timeout=5)
        daemon = start_daemon(root, profile)
        assert jobs(root)[0]["state"] == "experiment"
        print("PASS daemon restart during live experiment", flush=True)
        deadline = time.monotonic() + 175
        while time.monotonic() < deadline:
            rows = jobs(root)
            bad = [job for job in rows if job["state"] in
                   ("blocked", "uncertain", "launch_failed", "continuation_failed")]
            if bad:
                raise RuntimeError(f"ADF job failures: {bad}")
            if len(rows) == 3 and all(job["state"] == "done" for job in rows):
                break
            time.sleep(1)
        else:
            raise TimeoutError(f"expected two experiments and one spawn; actual jobs: {jobs(root)}")

        assert [job["experiment_result"]["exit_code"] for job in rows[:2]] == [0, 7]
        assert [job["codex_result"]["thread_id"] for job in rows[:2]] == [thread, thread]
        for job in rows[:2]:
            log = queue / "jobs" / job["id"] / "codex.jsonl"
            assert marker in agent_messages(log)
        assert rows[2]["codex_result"]["thread_id"] != thread
        fresh = queue / "jobs" / rows[2]["id"] / "codex.jsonl"
        assert agent_messages(fresh).strip() == "FRESH-A-C-F-OK"
        assert marker not in fresh.read_text(errors="replace")
        assert "ADF-SANDBOX-PROTECTED" in experiment_log.read_text(errors="replace")
        assert not (queue / "experiment-forbidden").exists()
        assert trial_runs.read_text().splitlines() == ["4", "7"]
        assert len(jobs(root)) == 3
        print(f"PASS two real resumes {thread}; fresh {rows[2]['codex_result']['thread_id']}", flush=True)
    finally:
        if daemon.poll() is None:
            daemon.terminate()
        daemon.wait(timeout=5)


def start_daemon(root, profile):
    args = [sys.executable, "-m", "adf", "start", "--enable-experiments"]
    if profile:
        args += ["--profile", profile]
    return subprocess.Popen(args, cwd=root)


def agent_messages(path):
    messages = []
    for line in path.read_text(errors="replace").splitlines():
        item = json.loads(line).get("item", {})
        if item.get("type") == "agent_message":
            messages.append(item["text"])
    return "\n".join(messages)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", help="existing Codex config profile with workspace write")
    args = parser.parse_args()
    for key in ("GH_TOKEN", "GITHUB_TOKEN"):
        os.environ.pop(key, None)
    with tempfile.TemporaryDirectory(prefix="adf-live-") as temporary:
        main(Path(temporary).resolve(), args.profile)
