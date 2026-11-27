"""Command-line interface for ADF."""

import argparse
import json
import os
import sqlite3
import sys
import time
from uuid import uuid4

from .ipc_support import MAX_REQUEST, atomic_json
from .processes import codex_turn, lock, new_turn
from .service import inbox_path, initialize, queue_path, repository, require_command, serve


def submit(root, payload):
    payload.update(turn=os.environ.get("ADF_TURN_ID"), thread=os.environ.get("CODEX_THREAD_ID"),
                   token=os.environ.get("ADF_TURN_PROOF"))
    if not all(payload[key] for key in ("turn", "thread", "token")):
        raise ValueError("run this inside a Codex execution started with 'python3 -m adf session'")
    if len(json.dumps(payload).encode()) > MAX_REQUEST:
        raise ValueError("request too large")
    name = f"{uuid4()}.json"
    atomic_json(inbox_path(root) / name, payload)
    ack = queue_path(root) / "acks" / name
    end = time.monotonic() + 10
    while time.monotonic() < end:
        if ack.exists():
            response = json.loads(ack.read_text())
            if "error" in response:
                raise ValueError(response["error"])
            print(response["id"])
            return 0
        time.sleep(0.1)
    raise ValueError("no acknowledgement; check ADF or retry the same request before ending this execution")


def status(queue, job_id):
    path = queue / "state.sqlite3"
    jobs = []
    if path.is_file():
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT * FROM jobs WHERE (? IS NULL OR id = ?) ORDER BY accepted_at", (job_id, job_id)
            )
            for row in rows:
                job = dict(row)
                for field in ("request", "experiment_result", "codex_result"):
                    job[field] = json.loads(job[field]) if job[field] is not None else None
                jobs.append(job)
    print(json.dumps({"paused": (queue / "paused").exists(), "jobs": jobs}, ensure_ascii=False, indent=2))


def parse_args():
    parser = argparse.ArgumentParser(prog="python3 -m adf")
    commands = parser.add_subparsers(dest="operation", required=True)
    start = commands.add_parser("start", help="serve requests in the foreground")
    start.add_argument("--enable-experiments", action="store_true",
                       help="authorize detached experiments under normal Codex tool policy")
    start.add_argument("--profile", help="Codex config profile for all ADF executions")
    session = commands.add_parser("session", help="launch the initial Codex CLI independently")
    session.add_argument("prompt")
    run = commands.add_parser("run-and-resume", help="request an experiment followed by same-thread continuation")
    run.add_argument("argv", metavar="JSON_ARGV")
    spawn = commands.add_parser("spawn", help="request a fresh Codex CLI session")
    spawn.add_argument("prompt")
    inspect = commands.add_parser("status", help="inspect accepted requests")
    inspect.add_argument("id", nargs="?")
    commands.add_parser("pause", help="persistently stop dispatching new operations")
    commands.add_parser("unpause", help="allow dispatch to continue")
    return parser.parse_args()


def main():
    args = parse_args()
    root = repository()
    queue = queue_path(root)
    if args.operation == "start":
        serve(root, args.profile, args.enable_experiments)
    elif args.operation == "session":
        settings_path = queue / "settings.json"
        if not settings_path.is_file():
            raise ValueError("start ADF before launching a session")
        settings = json.loads(settings_path.read_text())
        directory, lease, token = new_turn(queue, settings)
        with lease:
            result = codex_turn(root, settings, directory, token, args.prompt, sys.stdout.buffer)
        if result.get("error"):
            raise ValueError(result["error"])
        return result["exit_code"]
    elif args.operation == "run-and-resume":
        argv = require_command(json.loads(args.argv))
        return submit(root, {"kind": "run_and_resume", "argv": argv})
    elif args.operation == "spawn":
        return submit(root, {"kind": "spawn", "prompt": args.prompt})
    elif args.operation == "status":
        status(queue, args.id)
    else:
        initialize(root)
        with lock(queue / "control.lock", blocking=True):
            if args.operation == "pause":
                atomic_json(queue / "paused", True)
            else:
                (queue / "paused").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(f"ADF: {exc}", file=sys.stderr)
        sys.exit(1)
