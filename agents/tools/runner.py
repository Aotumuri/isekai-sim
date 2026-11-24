"""Run explicit experiment commands from a fixed Git snapshot on POSIX."""

import argparse
import json
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from control import finish_if_no_wake, saved_jobs, settle, TERMINAL
from policy import CONTROL, LOCK, auto_resume, config, control, owner, require_running, wake_scope
from storage import ROOT, RUNTIME, git, lock, now, read, write

JOBS = RUNTIME / "jobs"


def token(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", value):
        raise argparse.ArgumentTypeError("Use 1–80 letters, digits, underscores or hyphens")
    return value


def positive(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("Expected a positive integer")
    return number


def start(args):
    require_running()
    if not args.command:
        raise ValueError("Specify an explicit experiment command after --")
    revision = git("rev-parse", "--verify", "--end-of-options", args.revision + "^{commit}")
    dependencies = ROOT / "node_modules" if args.reuse_node_modules else None
    if dependencies and (not dependencies.is_dir() or
                         git("show", revision + ":package-lock.json") !=
                         (ROOT / "package-lock.json").read_text().strip()):
        raise ValueError("Expected installed node_modules and a matching workspace package-lock.json")
    queue_cli = None
    if args.acceptance_probe and not args.notify_thread:
        raise ValueError("An acceptance probe requires --notify-thread for the current Developer owner")
    if args.notify_thread:
        if args.notify_thread != owner():
            raise ValueError("Notification target must be the current Developer owner")
        if not args.acceptance_probe and not auto_resume():
            raise ValueError("Automatic continuation is disabled by repository policy")
        queue_cli = next((cli for cli in cli_candidates() if supports_queue(cli)), None)
        if not queue_cli:
            raise ValueError("No Codex CLI with --thread/--message/--resume queue support")
    job = JOBS / args.id
    job.mkdir(parents=True)
    (job / "artifacts").mkdir()
    manifest = {
        "id": args.id, "status": "queued", "revision": revision, "command": args.command,
        "created_at": now(), "timeout_s": args.timeout, "max_file_mib": args.max_file_mib,
        "cpu_seconds": args.cpu_seconds, "node_modules": str(dependencies) if dependencies else None,
        "env": dict(args.env), "log": "experiment.log", "artifacts": "artifacts",
        "notification": {"thread": args.notify_thread, "cli": queue_cli, "attempts": 0,
                         "generation": control()["generation"], "acceptance_probe": args.acceptance_probe,
                         "status": "pending" if args.notify_thread else "disabled"},
    }
    write(job / "manifest.json", manifest)
    try:
        launch_supervisor(job)
    except OSError as error:
        finish(job, manifest, "interrupted", error=str(error))
        raise
    return manifest


def launch_supervisor(job):
    with (job / "supervisor.log").open("ab") as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_run", job.name],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True)


def snapshot(job, manifest):
    archive = job / "source.tar"
    source = job / "source"
    source.mkdir()
    try:
        subprocess.run(["git", "archive", "--format=tar", "-o", str(archive), manifest["revision"]],
                       cwd=ROOT, check=True, timeout=manifest["timeout_s"])
        with tarfile.open(archive) as bundle:
            bundle.extractall(source, filter="data")
    finally:
        archive.unlink(missing_ok=True)
    if manifest["node_modules"]:
        (source / "node_modules").symlink_to(manifest["node_modules"], target_is_directory=True)
    return source


def limits(manifest):
    # The supervisor is single-threaded and the child immediately execs.
    for kind, requested in ((resource.RLIMIT_FSIZE, manifest["max_file_mib"] * 1024**2),
                            (resource.RLIMIT_CPU, manifest["cpu_seconds"])):
        if requested is not None:
            _, hard = resource.getrlimit(kind)
            limit = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
            resource.setrlimit(kind, (limit, hard))


def stop(process):
    def send(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass

    send(signal.SIGTERM)
    if hasattr(os, "waitid"):
        # Keep the leader unreaped so its process-group ID cannot be recycled.
        time.sleep(1)
        try:
            send(signal.SIGKILL)
        except PermissionError:
            exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            if exited is None:
                raise
    else:
        try:
            return process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            send(signal.SIGKILL)
    return process.wait()


def execute(job, source, manifest, lease, deadline):
    env = {**os.environ, **manifest["env"], "EXPERIMENT_ARTIFACTS": str(job / "artifacts")}
    with (job / manifest["log"]).open("ab", buffering=0) as log:
        with subprocess.Popen(manifest["command"], cwd=source, env=env,
                              stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                              start_new_session=True, pass_fds=(lease.fileno(),),
                              preexec_fn=lambda: limits(manifest)) as process:
            while True:
                remaining = deadline - time.monotonic()
                if (job / "cancel").exists():
                    return "cancelled", stop(process)
                if remaining <= 0:
                    return "timed_out", stop(process)
                try:
                    code = process.wait(timeout=min(remaining, 0.25))
                    return ("succeeded" if code == 0 else "failed"), code
                except subprocess.TimeoutExpired:
                    continue


def finish(job, manifest, status, *, exit_code=None, **details):
    manifest.update(status=status, ended_at=now(), exit_code=exit_code, **details)
    # Completion is durable before attempting any external delivery.
    write(job / "manifest.json", manifest)


def cli_candidates():
    override = os.environ.get("CODEX_CLI_PATH")
    configured = config().get("execution", {}).get("codex_cli_path")
    candidates = (override,) if override else (
        configured, "codex", os.environ.get("CODEX_APP_RUNTIME_CLI_PATH"))
    paths = {}
    for candidate in filter(None, candidates):
        executable = shutil.which(os.path.expanduser(candidate))
        if executable:
            paths[os.path.abspath(executable)] = None
    return list(paths)


def probe(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        return result.stdout if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def supports_queue(cli):
    help_text = probe([cli, "help", "queue"])
    return "Queue a message for an existing session" in help_text and all(
        flag in help_text for flag in ("--thread", "--message", "--resume"))


def capabilities():
    cli = [{"path": path, "version": probe([path, "--version"]).strip(),
            "queue": supports_queue(path),
            "resume": "SESSION_ID" in probe([path, "exec", "resume", "--help"]),
            "app_server": "--listen" in probe([path, "app-server", "--help"])}
           for path in cli_candidates()]
    return {
        "codex": cli,
        "notification_cli": next((entry["path"] for entry in cli if entry["queue"]), None),
        "thread_hint_present": bool(os.environ.get("CODEX_THREAD_ID")),
        "desktop_runtime_present": bool(os.environ.get("CODEX_APP_RUNTIME_CLI_PATH")),
        "tmux": bool(shutil.which("tmux")),
        "background_method": "POSIX detached supervisor; host lifetime must be tested",
    }


def notify(job, manifest):
    delivery = manifest["notification"]
    # A crash or timeout after sending has ambiguous delivery. Keep that state for
    # manual inspection rather than starting another possibly duplicate turn.
    if delivery["status"] != "pending":
        return
    for attempt in range(1, 4):
        try:
            with (job / "notification.log").open("ab") as log:
                with lock(LOCK):
                    scope, generation = wake_scope(manifest["id"], delivery)
                    if scope == "shutdown":
                        state = control()
                        if (state.get("shutdown_notify_job", manifest["id"]) != manifest["id"]
                                or any(item["status"] not in TERMINAL for item in saved_jobs(state))):
                            scope = None
                        else:
                            state["shutdown_notify_job"] = manifest["id"]
                            write(CONTROL, state)
                    if scope is None or (job / "cancel").exists():
                        delivery["status"] = "suppressed"
                        break
                    message = (f"Experiment {manifest['id']} ended ({manifest['status']}). First run "
                               f"python3 agents/tools/control.py validate-wake {manifest['id']} {generation}. "
                               "If validation fails, end the turn. ")
                    if scope == "shutdown":
                        message += ("Graceful shutdown only. Inspect all shutdown job manifests, record results "
                                    "and the handover, then run control.py finalize and end the turn. "
                                    "Do not start research or launch jobs.")
                    elif delivery.get("acceptance_probe"):
                        message += ("One-shot acceptance probe. Read acceptance-checkpoint.json, validate the result "
                                    "and record evidence in acceptance-result.json. Release ownership and end the turn "
                                    "without starting research.")
                    delivery.update(status="sending", attempts=attempt, wake_scope=scope)
                    write(job / "manifest.json", manifest)
                    process = subprocess.Popen([delivery["cli"], "queue", "--resume", "--thread",
                                                delivery["thread"], "--message", message], cwd=ROOT,
                                               stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise
            if process.returncode == 0:
                delivery["status"] = "accepted"
                break
            # Even a nonzero exit can follow acceptance. Only retry when the
            # executable could not be started at all.
            delivery.update(status="failed", exit_code=process.returncode)
            break
        except subprocess.TimeoutExpired:
            delivery["status"] = "unknown"
            break
        except OSError as error:
            delivery.update(status="failed", error=str(error))
            if attempt < 3:
                time.sleep(attempt)
    write(job / "manifest.json", manifest)


def supervise(job):
    with lock(job / "execution.lock", blocking=False) as lease:
        manifest = read(job / "manifest.json")
        if manifest["status"] != "queued":
            return
        began = time.monotonic()
        manifest.update(status="running", started_at=now())
        write(job / "manifest.json", manifest)
        code, error = None, None
        try:
            if (job / "cancel").exists():
                status = "cancelled"
            else:
                source = snapshot(job, manifest)
                deadline = began + manifest["timeout_s"]
                if time.monotonic() >= deadline:
                    status = "timed_out"
                else:
                    status, code = execute(job, source, manifest, lease, deadline)
        except subprocess.TimeoutExpired as exc:
            status, error = "timed_out", str(exc)
        except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as exc:
            status, error = "failed", str(exc)
        finish(job, manifest, status, exit_code=code,
               duration_s=round(time.monotonic() - began, 3), error=error)
        notify(job, manifest)
        with lock(LOCK):
            finish_if_no_wake()
            settle()


def inspect(job, action):
    manifest = read(job / "manifest.json")
    if action == "cancel" and manifest["status"] not in TERMINAL:
        (job / "cancel").touch()
    if action == "recover":
        try:
            with lock(job / "execution.lock", blocking=False):
                manifest = read(job / "manifest.json")
                if manifest["status"] == "running":
                    finish(job, manifest, "interrupted", error="Supervisor and experiment lease ended")
                elif manifest["status"] == "queued":
                    if (job / "cancel").exists():
                        finish(job, manifest, "cancelled", error="Cancelled before launch")
                    else:
                        raise ValueError("Job has not started. Use --relaunch-queued to launch it safely.")
                if manifest["notification"]["status"] == "sending":
                    manifest["notification"]["status"] = "unknown"
                    write(job / "manifest.json", manifest)
                notify(job, manifest)
                with lock(LOCK):
                    finish_if_no_wake()
        except BlockingIOError:
            pass
    return read(job / "manifest.json")


def env_pair(value):
    key, sep, setting = value.partition("=")
    if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or key == "EXPERIMENT_ARTIFACTS":
        raise argparse.ArgumentTypeError("Expected NAME=VALUE")
    return key, setting


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    launch = actions.add_parser("start")
    launch.add_argument("id", type=token)
    launch.add_argument("--revision", default="HEAD")
    launch.add_argument("--timeout", type=positive, required=True)
    launch.add_argument("--cpu-seconds", type=positive)
    launch.add_argument("--max-file-mib", type=positive, default=64)
    launch.add_argument("--reuse-node-modules", action="store_true")
    launch.add_argument("--env", type=env_pair, action="append", default=[])
    launch.add_argument("--notify-thread", help="Explicitly opt in to one Codex continuation request")
    launch.add_argument("--acceptance-probe", action="store_true",
                        help="Owner-authorized, bounded wake test without autonomous research")
    actions.add_parser("capabilities")
    actions.add_parser("list")
    for name in ("status", "cancel", "recover", "_run"):
        command = actions.add_parser(name)
        command.add_argument("id", type=token)
        if name == "recover":
            command.add_argument("--relaunch-queued", action="store_true")
    cli, separator, command = (sys.argv[1:], None, [])
    if "--" in cli:
        split = cli.index("--")
        cli, separator, command = cli[:split], "--", cli[split + 1:]
    args = parser.parse_args(cli)
    if separator and args.action != "start":
        parser.error("-- COMMAND is supported only by start")
    if args.action == "capabilities":
        result = capabilities()
    elif args.action == "start":
        args.command = command
        with lock(LOCK):
            result = start(args)
    elif args.action == "list":
        result = [read(path) for path in sorted(JOBS.glob("*/manifest.json"))]
    elif args.action == "_run":
        try:
            supervise(JOBS / args.id)
        except BlockingIOError:
            pass  # Another supervisor already holds this job.
        return
    elif args.action == "recover" and args.relaunch_queued:
        job = JOBS / args.id
        with lock(LOCK):
            require_running()
            if read(job / "manifest.json")["status"] != "queued" or (job / "cancel").exists():
                raise ValueError("Only uncancelled queued jobs can be relaunched")
            launch_supervisor(job)
        result = read(job / "manifest.json")
    else:
        result = inspect(JOBS / args.id, args.action)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
