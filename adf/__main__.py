"""Standalone desktop launcher and command line interface."""

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

from .codex import RuntimeError
from .ipc import Client, serve
from .service import runtime_path
from .store import default_home, private_dir


def parser():
    cli = argparse.ArgumentParser(prog="adf", description="Autonomous Development Framework")
    sub = cli.add_subparsers(dest="action", required=True)
    for action in ("gui", "daemon", "limits", "bridge"):
        sub.add_parser(action)
    register = sub.add_parser("register")
    register.add_argument("path")
    register.add_argument("--name", default="")
    register.add_argument("--github", default="")
    for action in ("archive", "issues", "template", "send", "resume", "stop"):
        command = sub.add_parser(action)
        command.add_argument("project", type=int)
        if action in ("send", "resume", "stop"):
            command.add_argument("role")
        if action == "send":
            command.add_argument("text")
            command.add_argument("--experiment")
        elif action == "resume":
            command.add_argument("text", nargs="?", default="")
        elif action == "stop":
            command.add_argument("--immediate", action="store_true")
        elif action == "template":
            command.add_argument("name")
            command.add_argument("argv", type=json.loads, help='JSON array, e.g. ["/bin/sleep","15"]')
            command.add_argument("--timeout", type=int, default=300)
    task = sub.add_parser("task", help="研究課題を登録")
    task.add_argument("project", type=int)
    task.add_argument("title")
    task.add_argument("criteria")
    task.add_argument("--priority", type=int, default=3)
    task.add_argument("--depends-on", dest="dependencies", type=int, action="append")
    task = sub.add_parser("task-reopen")
    task.add_argument("project", type=int)
    task.add_argument("task", type=int)
    task.add_argument("criteria")
    research = sub.add_parser("research-start", help="承認した範囲で研究を開始")
    research.add_argument("project", type=int)
    research.add_argument("scope")
    research.add_argument("tasks", type=int, nargs="+")
    for name in ("jobs", "turns", "tokens"):
        research.add_argument(f"--{name}", type=int, help="0 は無制限")
    research.add_argument("--timeout", type=int, help="実験 1 回の上限秒数（正の整数）")
    research.add_argument("--preset", choices=("manual", "controlled", "autonomous"))
    research.add_argument("--recovery", choices=("manual", "confirmed"))
    research.add_argument("--runtime", choices=("python", "node"), default="python")
    research.add_argument("--file", dest="files", action="append")
    research.add_argument("--dependencies", default="")
    research.add_argument("--evidence", action="append")
    research = sub.add_parser("research-resume")
    research.add_argument("project", type=int)
    research.add_argument("--accept-issue-changes", action="store_true")
    research.add_argument("--tokens", type=int, help="使用済み分を含む新しい合計予算。0 は無制限")
    preset = sub.add_parser("research-preset", help="プロジェクトの運用プリセットを表示・プレビュー・適用")
    preset.add_argument("project", type=int)
    preset.add_argument("name", choices=("manual", "controlled", "autonomous"), nargs="?")
    preset.add_argument("--apply", action="store_true")
    for name in ("jobs", "turns", "tokens"):
        preset.add_argument(f"--{name}", type=int, help="0 は無制限")
    preset.add_argument("--timeout", type=int, help="実験 1 回の上限秒数（正の整数）")
    preset.add_argument("--recovery", choices=("manual", "confirmed"))
    artifacts = sub.add_parser("artifacts")
    artifacts.add_argument("job")
    artifacts.add_argument("path", nargs="?")
    artifacts.add_argument("--offset", type=int, default=0)
    artifacts.add_argument("--size", type=int, default=4096)
    inputs = sub.add_parser("experiment-inputs")
    inputs.add_argument("job")
    usage = sub.add_parser("usage")
    usage.add_argument("project", type=int)
    preview = sub.add_parser("commit-preview")
    preview.add_argument("project", type=int)
    tracker = sub.add_parser("tracker-policy")
    tracker.add_argument("project", type=int)
    tracker.add_argument("operations", nargs="*", metavar="OPERATION[=LEVEL]")
    tracker = sub.add_parser("tracker-draft")
    tracker.add_argument("project", type=int)
    tracker.add_argument("kind")
    tracker.add_argument("payload", type=json.loads)
    tracker = sub.add_parser("tracker-review")
    tracker.add_argument("operation")
    answer = tracker.add_mutually_exclusive_group(required=True)
    answer.add_argument("--approve", action="store_true", dest="approve")
    answer.add_argument("--decline", action="store_false", dest="approve")
    tracker = sub.add_parser("tracker-reconcile")
    tracker.add_argument("operation")
    choice = tracker.add_mutually_exclusive_group()
    choice.add_argument("--accept-external-edit", action="store_true")
    choice.add_argument("--confirm-unapplied", action="store_true")
    tracker = sub.add_parser("tracker-issue")
    tracker.add_argument("project", type=int)
    tracker.add_argument("issue", type=int)
    legacy = sub.add_parser("legacy-preview")
    legacy.add_argument("project", type=int)
    legacy = sub.add_parser("legacy-import")
    legacy.add_argument("project", type=int)
    legacy.add_argument("fingerprint")
    status = sub.add_parser("status")
    status.add_argument("project", type=int, nargs="?")
    status.add_argument("--after", type=int, default=0)
    log = sub.add_parser("log")
    log.add_argument("job")
    role = sub.add_parser("role")
    role.add_argument("name")
    for key in ("instructions", "model", "effort"):
        role.add_argument(f"--{key}", default="")
    role.add_argument("--recovery", choices=("manual", "confirmed"), default="manual")
    role.add_argument("--budget", type=int, default=0)
    shutdown = sub.add_parser("shutdown")
    shutdown.add_argument("--immediate", action="store_true")
    return cli


def main():
    args = vars(parser().parse_args())
    action = args.pop("action")
    if action == "tracker-policy":
        args["operations"] = {key: level or "ask"
                              for key, _, level in (value.partition("=") for value in args["operations"])}
    try:
        home = private_dir(default_home())
        if action == "daemon":
            asyncio.run(serve(home, runtime_path()))
        elif action == "gui":
            bundle = Path.home() / "Applications/ADF.app"
            if not bundle.is_dir():
                raise ValueError("ADF.app をビルドして起動してください。手順は adf/README.md にあります")
            subprocess.run(["/usr/bin/open", str(bundle)], check=True)
        elif action == "bridge":
            from .desktop_bridge import bridge
            bridge(Client(home))
        else:
            result = Client(home).call(action, **args)
            print(result if action == "log" else json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except BlockingIOError:
        return 0
    except (OSError, ValueError, RuntimeError, ImportError, subprocess.CalledProcessError) as error:
        print(f"ADF: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
