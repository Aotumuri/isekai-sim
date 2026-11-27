"""Opt-in test of the official Codex CLI with real inference; no GitHub calls."""

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
SUCCESS = ["/bin/sh", "-c", "printf 'ADF-experiment-one\\n'; sleep 6"]
FAILURE = ["/bin/sh", "-c", "printf 'ADF-experiment-two\\n'; exit 7"]


def invoke(root, *args):
    return subprocess.check_output(
        [sys.executable, "-m", "adf", *args], cwd=root, text=True, timeout=90
    )


def jobs(root):
    return json.loads(invoke(root, "status"))["jobs"]


def request(command):
    return "python3 -m adf run-and-resume '" + json.dumps(command).replace("'", "'\"'\"'") + "'"


def main(root):
    subprocess.run(["git", "init", "-q", str(root)], check=True, timeout=10)
    shutil.copytree(SOURCE / "adf", root / "adf",
                    ignore=shutil.ignore_patterns("runtime", "queue", "__pycache__"))
    shutil.copytree(SOURCE / ".agents/skills", root / ".agents/skills")
    shutil.copyfile(SOURCE / "AGENTS.md", root / "AGENTS.md")
    daemon = start_daemon(root)
    try:
        queue = root / "adf/queue"
        deadline = time.monotonic() + 5
        while not (queue / "state.sqlite3").exists():
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
  if touch adf/queue/forbidden 2>/dev/null; then exit 1; fi
Then run exactly this command and after a job ID is returned end your turn immediately:
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
        assert "touch adf/queue/forbidden" in initial
        source_job = jobs(root)[0]
        experiment_log = queue / "jobs" / source_job["id"] / "experiment.log"
        deadline = time.monotonic() + 5
        while not experiment_log.exists() or "ADF-experiment-one" not in experiment_log.read_text():
            if time.monotonic() >= deadline:
                raise TimeoutError("detached experiment did not start")
            time.sleep(0.1)
        assert jobs(root)[0]["state"] == "experiment"
        daemon.kill()
        daemon.wait(timeout=5)
        daemon = start_daemon(root)
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
        assert marker not in fresh.read_text()
        assert experiment_log.read_text().count("ADF-experiment-one") == 1
        assert len(jobs(root)) == 3
        print(f"PASS two real resumes {thread}; fresh {rows[2]['codex_result']['thread_id']}", flush=True)
    finally:
        if daemon.poll() is None:
            daemon.terminate()
        daemon.wait(timeout=5)


def start_daemon(root):
    return subprocess.Popen(
        [sys.executable, "-m", "adf", "start", "--allow-command", json.dumps(SUCCESS),
         "--allow-command", json.dumps(FAILURE)], cwd=root
    )


def agent_messages(path):
    messages = []
    for line in path.read_text().splitlines():
        item = json.loads(line).get("item", {})
        if item.get("type") == "agent_message":
            messages.append(item["text"])
    return "\n".join(messages)


if __name__ == "__main__":
    for key in ("GH_TOKEN", "GITHUB_TOKEN"):
        os.environ.pop(key, None)
    with tempfile.TemporaryDirectory(prefix="adf-live-") as temporary:
        main(Path(temporary).resolve())
