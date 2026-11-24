"""Intake and single-writer task management, independent of the agent client."""

import argparse
import json
import re
import sys
import uuid

from control import recovery_context, settle
from github_tracker import GitHubTracker, STATES as GITHUB_STATES, migration_entries
from policy import LOCK, config, control, new_generation, require_running
from storage import RESEARCH, RUNTIME, git, lock, now, read, write

STATES = ("ready", "active", "waiting", "blocked", "done")
ONGOING = ("active", "waiting")
STATE = RESEARCH / "state.json"
INBOX = RESEARCH / "inbox"
OWNER = RUNTIME / "developer.json"
REMOTE_CHECKPOINT = RUNTIME / "github-checkpoint.json"


def idea_id(value):
    if not re.fullmatch(r"I-[a-f0-9]{32}", value):
        raise argparse.ArgumentTypeError("Invalid idea ID")
    return value


def owner_id(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise argparse.ArgumentTypeError("Use a unique chat ID or UUID as the owner")
    return value


def submit(args):
    body = sys.stdin.read().strip()
    if not args.title.strip() or not body:
        raise ValueError("Provide a title and proposal body")
    idea = "I-" + uuid.uuid4().hex
    write(INBOX / (idea + ".json"), {"id": idea, "created": now(), "title": args.title,
                                    "assessment": args.assessment, "body": body, "origin": args.origin}, exclusive=True)
    return idea


def status(state):
    unseen = [read(path) for path in sorted(INBOX.glob("I-*.json"))
              if path.stem not in state["reviews"] and path.stem not in state["tasks"]]
    lifecycle = settle()
    tasks = {key: {**task, "effective_status": "paused"} if
             lifecycle["mode"] != "running" and task["status"] in ONGOING else task
             for key, task in state["tasks"].items()}
    return {**state, "tasks": tasks, "owner": read(OWNER)["id"] if OWNER.exists() else None,
            "control": lifecycle, "unreviewed": unseen}


def ownership(args, owner):
    if args.action == "claim":
        if owner and args.owner != owner:
            raise ValueError(f"Developer ownership held by {owner}")
        write(OWNER, {"id": args.owner})
        return True
    if args.action == "handoff":
        if owner != args.previous:
            raise ValueError("Developer ownership changed; inspect status before retrying")
        current = control()
        if current["mode"] == "stopping":
            raise ValueError("Finalize shutdown or explicitly resume with the new owner")
        new_generation(current["mode"], "Developer handoff")
        write(OWNER, {"id": args.owner})
        return True
    if owner != args.owner:
        raise ValueError("Developer ownership required")
    if args.action == "release":
        if control()["mode"] == "stopping":
            raise ValueError("Keep the Developer owner until graceful handover is finalized")
        if control()["mode"] == "running":
            new_generation("running", "Developer released ownership")
        OWNER.unlink()
        return True
    return False


def review(args, state):
    idea = read(INBOX / (args.id + ".json"))
    if args.id in state["tasks"]:
        raise ValueError("Idea already accepted as a task")
    previous = state["reviews"].get(args.id)
    if previous and previous["outcome"] != "deferred":
        raise ValueError("Idea already has a final disposition")
    if previous:
        args.reason = f'{previous["reason"]}\nReconsidered: {args.reason}'
    if args.outcome == "ready":
        state["reviews"].pop(args.id, None)
        state["tasks"][args.id] = {"title": idea["title"], "status": "ready", "next": args.reason,
                                   "origin": idea.get("origin", "human")}
    else:
        state["reviews"][args.id] = {"outcome": args.outcome, "reason": args.reason}


def checkpoint(args, state):
    tasks = state["tasks"]
    if args.id not in tasks:
        raise ValueError(f"Unknown task: {args.id}")
    task = tasks[args.id]
    transition = {
        "ready": ("active",),
        "active": ("active", "waiting", "blocked", "done"),
        "waiting": ("active", "waiting", "blocked", "done"),
        "blocked": ("active", "blocked"),
        "done": (),
    }
    if args.status not in transition[task["status"]]:
        raise ValueError(f'Cannot move {task["status"]} to {args.status}')
    if args.status in ONGOING and any(key != args.id and entry["status"] in ONGOING
                                      for key, entry in tasks.items()):
        raise ValueError("Another task is already active or waiting")
    if args.status == "waiting" and not args.job:
        raise ValueError("A waiting checkpoint requires at least one job ID")
    for job in args.job or []:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", job):
            raise ValueError(f"Invalid job ID: {job}")
        if not (RUNTIME / "jobs" / job / "manifest.json").is_file():
            raise ValueError(f"No manifest for job: {job}")
    task.update(status=args.status, next=args.next, updated_at=now(), **recovery_context())
    if args.job:
        task["jobs"] = args.job


def github_command(args, settings):
    tracker = GitHubTracker(settings)
    operation = args.operation
    if operation == "list":
        return [tracker.summary(issue) for issue in tracker.issues()]
    saved = read(REMOTE_CHECKPOINT) if REMOTE_CHECKPOINT.exists() else {}
    if operation == "show":
        processed = saved.get("processed", []) if saved.get("issue") == args.number else []
        return tracker.detail(args.number, processed)
    if operation == "migrate":
        if args.apply and settings["tracker"]["backend"] != "local":
            raise ValueError("Migrate from local mode before selecting GitHub as the tracker")
        entries = migration_entries(read(STATE), {p.stem: read(p) for p in INBOX.glob("I-*.json")})
        return tracker.migration(entries, args.apply, args.approved)
    if operation == "setup-labels":
        return tracker.setup_labels(args.approved)
    if settings["tracker"]["backend"] != "github":
        raise ValueError("Select GitHub as the authoritative tracker for issue changes")
    if operation == "create":
        return tracker.create(args.title, sys.stdin.read(), args.origin, args.key, args.approved,
                              parent=args.parent, priority=args.priority)
    if operation == "link":
        return tracker.link(args.number, args.related, args.relation, args.approved, args.reference)
    if operation == "comment":
        return tracker.comment(args.number, sys.stdin.read(), args.key, args.approved)
    if operation == "progress":
        if args.status != "paused":
            require_running()
        return tracker.progress(args.number, args.status, args.approved, args.published, args.check_task)
    if operation == "checklist":
        return tracker.checklist(args.number, args.check_task, args.approved, args.result_comment)
    with lock(LOCK):
        saved = read(REMOTE_CHECKPOINT) if REMOTE_CHECKPOINT.exists() else {}
        if not OWNER.exists() or read(OWNER)["id"] != args.owner:
            raise ValueError("Developer ownership required")
        if control()["mode"] != "running" and args.phase not in ("paused", "blocked"):
            require_running()
        processed = saved.get("processed", []) if saved.get("issue") == args.number else []
        for entry in args.processed:
            cid, sep, updated = entry.partition("@")
            if not sep or not cid.isdecimal() or not updated:
                raise ValueError("Use COMMENT_ID@UPDATED_AT")
            pair = [int(cid), updated]
            if pair not in processed:
                processed.append(pair)
        for job in args.job:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", job) or not (
                    RUNTIME / "jobs" / job / "manifest.json").is_file():
                raise ValueError(f"Unknown job: {job}")
        result = {"issue": args.number, "phase": args.phase, "next": args.next, "jobs": args.job,
                  "processed": processed, "control": control(), **recovery_context()}
        write(REMOTE_CHECKPOINT, result)
        return result


def number(value):
    if not value.isdecimal() or int(value) < 1:
        raise argparse.ArgumentTypeError("Expected a positive issue number")
    return int(value)


def github_parser(commands):
    actions = commands.add_parser("github").add_subparsers(dest="operation", required=True)
    actions.add_parser("list")
    actions.add_parser("setup-labels")
    for name in ("show", "checkpoint", "comment", "progress", "link", "checklist"):
        actions.add_parser(name).add_argument("number", type=number)
    create = actions.add_parser("create")
    create.add_argument("title")
    create.add_argument("--origin", required=True, choices=("human", "ai"))
    create.add_argument("--key", required=True)
    create.add_argument("--parent", type=number)
    create.add_argument("--priority")
    actions.choices["comment"].add_argument("--key", required=True)
    progress = actions.choices["progress"]
    progress.add_argument("status", choices=GITHUB_STATES)
    progress.add_argument("--published", action="store_true")
    progress.add_argument("--check-task", action="append", default=[], metavar="TEXT")
    checklist = actions.choices["checklist"]
    checklist.add_argument("--check-task", action="append", required=True, metavar="TEXT")
    checklist.add_argument("--result-comment", type=number, metavar="ID")
    link = actions.choices["link"]
    link.add_argument("related", type=number)
    link.add_argument("relation", choices=("child", "blocked-by"))
    link.add_argument("--reference", action="store_true", help="Explicit issue reference instead of a native relationship")
    save = actions.choices["checkpoint"]
    save.add_argument("owner", type=owner_id)
    save.add_argument("phase", choices=GITHUB_STATES)
    save.add_argument("next")
    save.add_argument("--job", action="append", default=[])
    save.add_argument("--processed", action="append", default=[])
    actions.add_parser("migrate").add_argument("--apply", action="store_true")
    for name in ("create", "comment", "progress", "link", "migrate", "checklist", "setup-labels"):
        actions.choices[name].add_argument("--approved", action="store_true")


def parse():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    intake = commands.add_parser("submit")
    intake.add_argument("title")
    intake.add_argument("--origin", choices=("human", "ai"), default="human")
    intake.add_argument("--assessment", required=True, choices=("ready", "investigate", "duplicate", "reject"))
    commands.add_parser("status")
    for name in ("claim", "release", "handoff", "review", "checkpoint"):
        commands.add_parser(name).add_argument("owner", type=owner_id)
    commands.choices["handoff"].add_argument("previous", type=owner_id)
    disposition = commands.choices["review"]
    disposition.add_argument("id", type=idea_id)
    disposition.add_argument("outcome", choices=("ready", "rejected", "deferred", "duplicate"))
    disposition.add_argument("reason")
    update = commands.choices["checkpoint"]
    update.add_argument("id")
    update.add_argument("status", choices=STATES)
    update.add_argument("next", help="Next action, blocker, or evidence for closure")
    update.add_argument("--job", action="append", default=None)
    github_parser(commands)
    return parser.parse_args()


def main():
    args = parse()
    settings = config()
    backend = settings.get("tracker", {}).get("backend", "local")
    if backend not in ("local", "github"):
        raise ValueError("Unknown tracker backend")
    if args.action == "github":
        print(json.dumps(github_command(args, settings), ensure_ascii=False, indent=2))
        return
    if backend == "github":
        if args.action in ("submit", "checkpoint", "review"):
            raise ValueError("GitHub is authoritative; use research.py github commands")
        if args.action == "status":
            with lock(LOCK):
                output = {"backend": backend, "control": settle(),
                          "owner": read(OWNER)["id"] if OWNER.exists() else None,
                          "checkpoint": read(REMOTE_CHECKPOINT) if REMOTE_CHECKPOINT.exists() else None}
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return
    if args.action == "submit":
        print(submit(args))
        return
    with lock(LOCK):
        state = read(STATE)
        if state["version"] != 1:
            raise ValueError("Unsupported research state version")
        if args.action == "status":
            print(json.dumps(status(state), ensure_ascii=False, indent=2))
            return
        owner = read(OWNER)["id"] if OWNER.exists() else None
        if ownership(args, owner):
            return
        if args.action == "review":
            review(args, state)
        else:
            continuing_shutdown = (
                control()["mode"] == "stopping" and state["tasks"].get(args.id, {}).get("status") in ONGOING
            )
            if args.status == "active" and not continuing_shutdown:
                require_running()
            checkpoint(args, state)
        write(STATE, state)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
