"""Run an experiment through the normal Codex command tool."""

import json
import shlex
import subprocess
import tempfile
import time

from .ipc_support import atomic_json
from .processes import codex_args, codex_environment


def matches_command(reported, expected):
    if reported == expected:
        return True
    try:
        words = shlex.split(reported)
    except (TypeError, ValueError, AttributeError):
        return False
    # Exec JSONL can report the login-shell wrapper around the tool input.
    return (
        len(words) == 3 and words[0].rsplit("/", 1)[-1] in {"bash", "zsh", "sh"}
        and words[1] in {"-c", "-lc"} and words[2] == expected
    )


def experiment(root, settings, argv, directory):
    command = shlex.join(argv)
    prompt = (
        "You are running a single authorized repository experiment. "
        "Use the normal Codex command execution tool once with the decoded command below. "
        "Keep the command exactly as provided. If it takes longer than the tool's first response, "
        "wait for that process to finish using the tool session. Follow all permission and approval "
        "rules. If declined or unavailable, stop. Do not retry, change files yourself, interpret the "
        "output, submit ADF requests, or run any other commands. End after the process exits.\n"
        + json.dumps({"command": command}, ensure_ascii=False)
    )
    result = {"exit_code": None, "error": "Codex did not confirm execution of the requested command"}
    events = {}
    with (directory / "experiment.log").open("wb") as log, tempfile.TemporaryFile() as source:
        source.write(prompt.encode())
        source.seek(0)
        try:
            with subprocess.Popen(
                [*codex_args(settings), "--ephemeral", "-"], cwd=root,
                env=codex_environment(settings), stdin=source,
                stdout=subprocess.PIPE, stderr=log,
            ) as child:
                for line in child.stdout:
                    log.write(line)
                    log.flush()
                    try:
                        event = json.loads(line)
                        item = event.get("item", {})
                    except (AttributeError, ValueError):
                        continue
                    if (event.get("type") in {"item.started", "item.completed"}
                            and item.get("type") == "command_execution"):
                        events[item["id"]] = item
                result["runner_exit_code"] = child.wait()
        except (OSError, ValueError, KeyError) as exc:
            result["error"] = f"Codex experiment runner failed: {exc}"
    if len(events) == 1:
        item = next(iter(events.values()))
        if matches_command(item.get("command"), command):
            if item.get("status") in {"completed", "failed"} and type(item.get("exit_code")) is int:
                result["exit_code"] = item["exit_code"]
                result.pop("error")
            elif item.get("status") == "declined":
                result["error"] = "Codex declined the requested command"
    result["finished_at"] = time.time()
    atomic_json(directory / "result.json", result)
