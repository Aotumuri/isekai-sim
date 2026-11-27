"""Repository-local request registration and execution."""

import hmac
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import time
import traceback
from uuid import uuid4

from .ipc_support import atomic_json, is_id, read_request
from .processes import codex_turn, experiment, lock, new_turn, receipt, token_hash

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    state TEXT NOT NULL,
    accepted_at REAL NOT NULL,
    started_at REAL,
    next_turn TEXT,
    finished_at REAL,
    experiment_result TEXT,
    codex_result TEXT,
    error TEXT
)
"""


def repository():
    root = Path(__file__).resolve().parent.parent
    if not (root / ".git").exists():
        raise ValueError("ADF must be installed at the root of a Git checkout")
    return root


def queue_path(root):
    return root / "adf" / "queue"


def initialize(root):
    queue = queue_path(root)
    queue.mkdir(mode=0o700, exist_ok=True)
    for name in ("requests", "acks", "turns", "jobs"):
        (queue / name).mkdir(mode=0o700, exist_ok=True)
    return queue


def codex_executable():
    executable = shutil.which("codex")
    if not executable:
        raise ValueError("codex was not found on PATH")
    return str(Path(executable).resolve())


def require_command(argv):
    if (not isinstance(argv, list) or not argv or not argv[0]
            or any(not isinstance(arg, str) or "\0" in arg for arg in argv)):
        raise ValueError("command must be a nonempty JSON argv array")
    return tuple(argv)


class Service:
    def __init__(self, root, queue, codex, commands, daemon_lock):
        self.root, self.queue, self.codex, self.commands = root, queue, codex, commands
        self.db = sqlite3.connect(queue / "state.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.execute(SCHEMA)
        self.children = set()
        self.daemon_lock = daemon_lock

    def register(self, request):
        if not isinstance(request, dict) or not is_id(request.get("turn")) or not is_id(request.get("thread")):
            raise ValueError("expected ADF_TURN_ID and CODEX_THREAD_ID from the current Codex CLI execution")
        job_id = request["turn"]
        token = request.pop("token", None)
        signature = self.queue / "turns" / job_id / "token-hash.json"
        if (not isinstance(token, str) or not signature.is_file()
                or not hmac.compare_digest(json.loads(signature.read_text()), token_hash(token))):
            raise ValueError("invalid Codex execution token")
        kind = request.get("kind")
        if kind == "run_and_resume":
            argv = require_command(request.get("argv"))
            fields = {"turn", "thread", "kind", "argv"}
        elif kind == "spawn" and isinstance(request.get("prompt"), str) and request["prompt"].strip():
            fields = {"turn", "thread", "kind", "prompt"}
        else:
            raise ValueError("expected an operator-authorized command or a nonempty startup instruction")
        if set(request) != fields:
            raise ValueError("unexpected request fields")
        encoded = json.dumps(request, sort_keys=True)
        saved = self.db.execute("SELECT request FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if saved:
            if saved["request"] != encoded:
                raise ValueError("this Codex execution already registered a different request")
            return {"id": job_id}
        if kind == "run_and_resume" and argv not in self.commands:
            raise ValueError("expected an operator-authorized command")
        if receipt(self.queue / "turns" / job_id) is not None:
            raise ValueError("this request must be registered before the Codex execution ends")
        with self.db:
            self.db.execute(
                "INSERT INTO jobs (id, request, state, accepted_at) VALUES (?, ?, 'waiting', ?)",
                (job_id, encoded, time.time()),
            )
        return {"id": job_id}

    def accept_requests(self):
        inbox = os.open(self.queue / "requests", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for name in sorted(os.listdir(inbox)):
                if not name.endswith(".json") or not is_id(name[:-5]):
                    continue
                try:
                    response = self.register(read_request(name, dir_fd=inbox))
                except (OSError, ValueError, RecursionError) as exc:
                    response = {"error": str(exc)}
                atomic_json(self.queue / "acks" / name, response)
                try:
                    os.unlink(name, dir_fd=inbox)
                except (FileNotFoundError, IsADirectoryError):
                    pass
        finally:
            os.close(inbox)

    def update(self, job_id, state, **fields):
        columns = {"state": state, **fields}
        with self.db:
            self.db.execute(
                "UPDATE jobs SET " + ", ".join(f"{column} = ?" for column in columns) + " WHERE id = ?",
                (*columns.values(), job_id),
            )

    def finish(self, job_id, state, error=None, **fields):
        self.update(job_id, state, finished_at=time.time(), error=error, **fields)

    def advance(self, row):
        job_id = row["id"]
        request = json.loads(row["request"])
        state = row["state"]
        if state == "waiting":
            result = receipt(self.queue / "turns" / job_id)
            if result is None:
                return
            if result.get("exit_code") != 0 or result.get("thread_id") != request["thread"] or result.get("error"):
                error = result.get("error") or "requesting Codex exited unsuccessfully or the thread did not match"
                self.finish(job_id, "blocked", error)
                return
            self.update(job_id, "ready_experiment" if request["kind"] == "run_and_resume" else "ready_codex")
        elif state == "experiment":
            result = receipt(self.queue / "jobs" / job_id)
            if result is None:
                return
            if "exit_code" not in result:
                self.finish(job_id, "uncertain", result["error"])
                return
            self.update(job_id, "ready_codex", experiment_result=json.dumps(result))
        elif state == "codex":
            result = receipt(self.queue / "turns" / row["next_turn"])
            if result is None:
                return
            error = result.get("error")
            if request["kind"] == "spawn" and result.get("thread_id") == request["thread"]:
                error = "fresh Codex invocation returned the requesting thread ID"
            if "exit_code" not in result:
                state = "uncertain"
            elif error or result["exit_code"] != 0:
                state = "continuation_failed"
                error = error or f"Codex exited with code {result['exit_code']}"
            else:
                state = "done"
            self.finish(job_id, state, error, codex_result=json.dumps(result))

    def launch(self, row, control_lock):
        job_id = row["id"]
        request = json.loads(row["request"])
        directory = self.queue / "jobs" / job_id
        directory.mkdir(mode=0o700, exist_ok=True)
        state = "experiment" if row["state"] == "ready_experiment" else "codex"
        fields = {"started_at": row["started_at"] or time.time()}
        if state == "experiment":
            if tuple(request["argv"]) not in self.commands:
                self.finish(job_id, "blocked", "experiment command is no longer authorized by the operator")
                return
            lease = lock(directory / "lock")
        else:
            fields["next_turn"] = str(uuid4())
            turn, lease, token = new_turn(self.queue, fields["next_turn"])
        if lease is None:
            self.finish(job_id, "uncertain", "execution lease already held")
            return

        # Persist launch intent before forking. A missing receipt after a lost
        # worker leaves an explicit uncertain state and never triggers a retry.
        with lease:
            self.update(job_id, state, **fields)
            try:
                pid = os.fork()
            except OSError as exc:
                self.finish(job_id, "launch_failed", str(exc))
                return
            if pid:
                self.children.add(pid)
                return
            try:
                self.daemon_lock.close()
                control_lock.close()
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                os.setsid()
                with open(os.devnull, "rb") as stdin, (directory / "worker.log").open("ab") as log:
                    os.dup2(stdin.fileno(), 0)
                    os.dup2(log.fileno(), 1)
                    os.dup2(log.fileno(), 2)
                if state == "experiment":
                    experiment(self.root, self.codex, request["argv"], directory)
                else:
                    self.continue_codex(row, request, directory, turn, token)
            except Exception:
                traceback.print_exc()
            finally:
                os._exit(0)

    def continue_codex(self, row, request, directory, turn, token):
        thread = None
        if request["kind"] == "spawn":
            prompt = request["prompt"]
        else:
            thread = request["thread"]
            result = json.loads(row["experiment_result"])
            log = (directory / "experiment.log").relative_to(self.root)
            prompt = (
                f"ADF experiment {row['id']} finished with exit code {result['exit_code']}. "
                f"Log: {log}. Inspect the result and continue the current task."
            )
        with (directory / "codex.jsonl").open("ab", buffering=0) as output:
            # Keep diagnostics with this invocation, including auth/startup failures.
            with (directory / "codex.stderr.log").open("ab", buffering=0) as errors:
                os.dup2(errors.fileno(), 2)
                codex_turn(self.root, self.codex, turn, token, prompt, output, thread)

    def step(self):
        for pid in tuple(self.children):
            if os.waitpid(pid, os.WNOHANG)[0]:
                self.children.remove(pid)
        self.accept_requests()
        rows = self.db.execute("SELECT * FROM jobs WHERE state IN ('waiting', 'experiment', 'codex')").fetchall()
        for row in rows:
            self.advance(row)
        with lock(self.queue / "control.lock", blocking=True) as control_lock:
            if (self.queue / "paused").exists():
                return
            running = self.db.execute("SELECT 1 FROM jobs WHERE state IN ('experiment', 'codex')").fetchone()
            if not running:
                ready = self.db.execute(
                    "SELECT * FROM jobs WHERE state IN ('ready_experiment', 'ready_codex') ORDER BY accepted_at LIMIT 1"
                ).fetchone()
                if ready:
                    self.launch(ready, control_lock)


def serve(root, commands):
    queue = initialize(root)
    daemon_lock = lock(queue / "service.lock")
    if daemon_lock is None:
        raise ValueError("ADF is already running for this checkout")
    with daemon_lock:
        service = Service(root, queue, codex_executable(), commands, daemon_lock)
        print(f"ADF ready in {root}", flush=True)
        try:
            while True:
                service.step()
                time.sleep(0.2)
        finally:
            service.db.close()
