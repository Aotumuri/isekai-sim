"""Project-local command line interface."""

import argparse
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

from .codex import RuntimeError
from .ipc import Client, serve
from .local import INSTALLATION, diagnostics, home_for, read_config, running, setup
from .presets import PRESETS
from .service import runtime_path
from .store import DESKTOP_TRANSFER, private_dir


def parser():
    cli = argparse.ArgumentParser(prog="adf", description="Autonomous Development Framework")
    sub = cli.add_subparsers(dest="action", required=True)
    for action in ("daemon", "limits", "doctor", "restart", "backup", "update", "issues", "usage",
                   "commit-preview", "history"):
        sub.add_parser(action)
    init = sub.add_parser("init")
    init.add_argument("--file", type=Path)
    config = sub.add_parser("config")
    config.add_argument("--file", type=Path)
    gui = sub.add_parser("gui")
    gui.add_argument("--no-open", action="store_true")
    start = sub.add_parser("start")
    start.add_argument("role", nargs="?")
    start.add_argument("text", nargs="?")
    skill = sub.add_parser("skill")
    skill.add_argument("role", choices=("coordinator", "developer"))
    migrate = sub.add_parser("migrate")
    migrate.add_argument("kind", choices=("legacy", "desktop"))
    migrate.add_argument("--source", type=Path)
    migrate.add_argument("--apply", metavar="FINGERPRINT")
    for action in ("template", "send", "resume", "stop"):
        command = sub.add_parser(action)
        if action in ("send", "resume", "stop"):
            command.add_argument("role", nargs="?" if action == "stop" else None)
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
    research = sub.add_parser("research-start", help="承認した範囲で研究を開始")
    research.add_argument("scope")
    research.add_argument("tasks", type=int, nargs="*")
    for name in ("jobs", "turns", "tokens"):
        research.add_argument(f"--{name}", type=int, help="0 は無制限")
    research.add_argument("--timeout", type=int, help="実験 1 回の上限秒数（正の整数）")
    research.add_argument("--preset", choices=PRESETS)
    research.add_argument("--empty-queue", choices=("stop", "wait", "discover"))
    research.add_argument("--discovery-issue", choices=("ask", "policy"))
    research.add_argument("--recovery", choices=("manual", "confirmed"))
    research.add_argument("--runtime", choices=("python", "node"), default="python")
    research.add_argument("--file", dest="files", action="append")
    research.add_argument("--dependencies", default="")
    research.add_argument("--evidence", action="append")
    research = sub.add_parser("research-resume")
    research.add_argument("--accept-issue-changes", action="store_true")
    research.add_argument("--scope", help="保存された Issue と現在の Mission に対して研究範囲を再承認")
    research.add_argument("--tokens", type=int, help="使用済み分を含む新しい合計予算。0 は無制限")
    preset = sub.add_parser("research-preset", help="プロジェクトの運用プリセットを表示・プレビュー・適用")
    preset.add_argument("name", choices=PRESETS, nargs="?")
    preset.add_argument("--apply", action="store_true")
    preset.add_argument("--empty-queue", choices=("stop", "wait", "discover"))
    preset.add_argument("--discovery-issue", choices=("ask", "policy"))
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
    tracker = sub.add_parser("tracker-policy")
    tracker.add_argument("operations", nargs="*", metavar="OPERATION[=LEVEL]")
    tracker = sub.add_parser("tracker-draft")
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
    tracker.add_argument("issue", type=int)
    status = sub.add_parser("status")
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


def wait_stopped(home):
    deadline = time.monotonic() + 30
    while running(home):
        if time.monotonic() >= deadline:
            raise ValueError("停止処理中です。実験または GitHub 操作が落ち着いてから再試行してください")
        time.sleep(0.15)


def start_core(home):
    if (home / DESKTOP_TRANSFER).exists():
        raise ValueError("Desktop の移行を完了してから監督を起動してください")
    read_config(home / "config.toml")
    client = Client(home)
    client.launch()
    return client.call("ping", launch=False, request_timeout=8)


def perform(action, args, root=INSTALLATION):
    home = home_for(root)
    if action == "init":
        return setup(root, args["file"])
    if action in {"doctor", "skill"}:
        result = diagnostics(root)
        if action == "skill":
            result["role"] = args["role"]
            if result["core_running"]:
                result["state"] = Client(home).call("status", launch=False, request_timeout=5)
        return result
    if action == "config":
        if args["file"]:
            if running(home):
                raise ValueError("先に監督を停止してください")
            return setup(root, args["file"], replace=True)
        return read_config(home / "config.toml")
    if action in {"backup", "update", "migrate"}:
        from .maintenance import maintain
        return maintain(root, home, action, args)
    if action == "daemon":
        config = read_config(home / "config.toml")
        asyncio.run(serve(private_dir(home), runtime_path(), root=root, config=config))
        return None
    if action in {"start", "restart", "gui"}:
        if action == "start" and args.get("role") and not (args.get("text") or "").strip():
            raise ValueError("管理セッションに最初の指示を入力してください")
        if action == "restart" and running(home):
            Client(home).call("shutdown", launch=False, immediate=False)
            wait_stopped(home)
        result = start_core(home)
        if action == "gui":
            from .web import serve_web
            return serve_web(home, open_browser=not args["no_open"])
        if action == "start" and args.get("role"):
            return Client(home).call("send", launch=False, role=args["role"], text=args["text"])
        return result
    if action == "stop" and not args["role"]:
        action, args = "shutdown", {"immediate": args["immediate"]}
    if not running(home):
        if action in {"status", "shutdown"}:
            return {"running": False, "configured": (home / "config.toml").is_file()}
        raise ValueError("監督が停止しています。python3 -m adf start を実行してください")
    return Client(home).call(action, launch=False, **args)


def main():
    args = vars(parser().parse_args())
    action = args.pop("action")
    if action == "tracker-policy":
        args["operations"] = {key: level or "ask"
                              for key, _, level in (value.partition("=") for value in args["operations"])}
    try:
        result = perform(action, args)
        if result is not None:
            print(result if action == "log" else json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except BlockingIOError:
        if action == "daemon":
            return 0
        print("ADF: 監督を停止してから操作してください", file=sys.stderr)
        return 1
    except (OSError, ValueError, RuntimeError, ImportError, subprocess.CalledProcessError) as error:
        print(f"ADF: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
