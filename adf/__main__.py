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
