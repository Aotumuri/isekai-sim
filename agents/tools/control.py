"""Inspect or explicitly change the research lifecycle."""

import argparse
import json
import re
import sys

from policy import LOCK, OWNER, control, new_generation, owner, permit, require_running, wake_scope
from storage import RUNTIME, git, lock, read, write

TERMINAL = {"succeeded", "failed", "timed_out", "cancelled", "interrupted"}


def active_jobs():
    jobs = ((path.parent, read(path)) for path in sorted((RUNTIME / "jobs").glob("*/manifest.json")))
    return [(path, job) for path, job in jobs if job["status"] not in TERMINAL]


def settle():
    state = control()
    if state["mode"] == "draining" and not active_jobs():
        return new_generation("paused", state["reason"])
    return state


def recovery_context():
    return {"branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "revision": git("rev-parse", "HEAD"),
            "changes": git("status", "--porcelain=v1", "--untracked-files=all", strip=False).splitlines()}


def saved_jobs(state):
    return [read(RUNTIME / "jobs" / job / "manifest.json") for job in state.get("jobs", [])]


def save_handover(state, note):
    jobs = [{"id": job["id"], "status": job["status"], "exit_code": job.get("exit_code"),
             "manifest": f"agents/runtime/jobs/{job['id']}/manifest.json"}
            for job in saved_jobs(state)]
    return {"note": note, "jobs": jobs, "workspace": recovery_context()}


def finish_shutdown(state, note):
    return new_generation("stopped", state["reason"], shutdown=state["shutdown"],
                          jobs=state["jobs"], handover=save_handover(state, note))


def finish_if_no_wake():
    state = control()
    if state["mode"] != "stopping" or not state.get("jobs"):
        return
    jobs = saved_jobs(state)
    if any(job["status"] not in TERMINAL for job in jobs):
        return
    if any(job["notification"].get("wake_scope") == "shutdown"
           and job["notification"]["status"] in ("pending", "sending", "accepted", "unknown")
           for job in jobs):
        return
    if any(job["notification"]["status"] == "pending" and job["notification"].get("thread")
           for job in jobs):
        return
    finish_shutdown(state, "Job results saved; review them on explicit resume.")


def change(action, reason, *, developer=None, previous=None):
    state = control()
    if action == "resume":
        current = owner()
        if developer and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", developer):
            raise ValueError("Invalid Developer owner ID")
        if developer and current not in (None, developer) and previous != current:
            raise ValueError("Verify the old Developer has ended, then specify --previous-owner")
        recovery = recovery_context()
        if developer:
            write(OWNER, {"id": developer})
        return new_generation("running", reason, recovery=recovery, previous_shutdown={
            key: state[key] for key in ("reason", "shutdown", "jobs", "handover") if key in state})
    if action == "graceful":
        if state["mode"] == "stopping":
            return state
        require_running()
        # Include just-completed jobs whose ordinary notification has not yet been handled.
        jobs = [path.parent.name for path in (RUNTIME / "jobs").glob("*/manifest.json")
                if (job := read(path))["status"] not in TERMINAL
                or (job["notification"].get("generation") == state["generation"]
                    and job["notification"]["status"] == "pending")]
        return new_generation("stopping", reason, shutdown="graceful",
                              prior_generation=state["generation"], jobs=sorted(jobs))
    if action in ("stop", "emergency-stop"):
        jobs = sorted(set(state.get("jobs", [])) | {path.name for path, _ in active_jobs()})
        prior = {"handover": state["handover"]} if "handover" in state else {}
        state = new_generation("stopped", reason, shutdown="immediate", jobs=jobs, **prior)
        for job, _ in active_jobs():
            (job / "cancel").touch()
        return state
    if action == "finalize":
        if state["mode"] == "stopping" and any(job["status"] not in TERMINAL for job in saved_jobs(state)):
            raise ValueError("Existing jobs are still running; end the turn and await completion")
        if state.get("shutdown") not in ("graceful", "immediate"):
            raise ValueError("No shutdown to finalize")
        return finish_shutdown(state, reason)
    mode = {"pause": "paused", "drain": "draining"}[action]
    new_generation(mode, reason)
    return settle()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("status")
    for name in ("graceful", "stop", "emergency-stop", "resume", "finalize", "pause", "drain"):
        actions.add_parser(name).add_argument("reason", help="Explicit instruction from the owner")
    actions.choices["resume"].add_argument("--owner")
    actions.choices["resume"].add_argument("--previous-owner")
    wake = actions.add_parser("validate-wake")
    wake.add_argument("job")
    wake.add_argument("generation")
    permission = actions.add_parser("permission")
    permission.add_argument("section", choices=("git", "tracker.github"))
    permission.add_argument("operation", choices=("commit", "push", "pull_request", "create_issue",
                                                  "update_issue", "comment", "close_issue"))
    permission.add_argument("--approved", action="store_true")
    args = parser.parse_args()
    with lock(LOCK):
        if args.action == "status":
            result = settle()
        elif args.action == "permission":
            permit(args.section, args.operation, args.approved)
            result = {"allowed": True}
        elif args.action == "validate-wake":
            if not args.job.isascii() or not args.job.replace("-", "").replace("_", "").isalnum():
                raise ValueError("Invalid job ID")
            manifest = read(RUNTIME / "jobs" / args.job / "manifest.json")
            delivery = manifest["notification"]
            scope, generation = wake_scope(args.job, delivery)
            if (generation != args.generation or scope != delivery.get("wake_scope")
                    or scope is None
                    or delivery.get("status") not in ("sending", "accepted", "unknown")
                    or manifest["status"] not in TERMINAL or manifest["status"] == "cancelled"):
                raise ValueError("Stale or unauthorized completion")
            receipt = RUNTIME / "jobs" / args.job / "wake-receipt.json"
            if receipt.exists():
                raise ValueError("Completion already received; recover its checkpoint manually")
            result = {**manifest, "wake_scope": scope}
            write(receipt, {"job": args.job, "generation": args.generation}, exclusive=True)
        else:
            result = change(args.action, args.reason, developer=getattr(args, "owner", None),
                            previous=getattr(args, "previous_owner", None))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
