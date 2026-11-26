"""Explicit opt-in bounded acceptance against the signed-in local Codex."""

import argparse
import asyncio
from pathlib import Path
import subprocess
import tempfile
import time

from adf.projects import snapshot
from adf.runtimes import runtime_command
from adf.service import Service, runtime_path
from adf.store import Store, private_dir
from test_adf import repo


async def check_permissions(runtime, root):
    source = root / "security"
    source.mkdir()
    outside = root / "canary"
    outside.write_text("canary")
    (source / ".env").write_text("canary")
    legacy = source / "agents/runtime"
    legacy.mkdir(parents=True)
    (legacy / "state.lock").touch()
    (source / "adf/runtime").mkdir(parents=True)
    (source / "adf/runtime/config.toml").write_text("canary")
    (source / "adf/launcher.py").write_text("canary")
    (source / "AGENTS.md").write_text("canary")
    for profile, expected in (("adf-reader", False), ("adf-writer", True)):
        # Use only synthetic files and test declared access with a trusted fixed command.
        result = await runtime.rpc("command/exec", {
            "command": ["/bin/sh", "-c",
                        'test ! -r "$1" && test ! -r .env && test ! -r agents/runtime/state.lock || exit 91; '
                        'test ! -r adf/runtime/config.toml && test -r adf/launcher.py || exit 93; '
                        'if (: >> agents/runtime/state.lock) 2>/dev/null; then exit 92; fi; '
                        'if (: >> adf/runtime/config.toml) 2>/dev/null; then exit 94; fi; '
                        'if (: >> adf/launcher.py) 2>/dev/null; then exit 95; fi; '
                        'if (: >> AGENTS.md) 2>/dev/null; then exit 96; fi; '
                        'if (echo ok > probe) 2>/dev/null; then exit 0; else exit 1; fi',
                        "sh", str(outside)],
            "cwd": str(source), "permissionProfile": profile, "timeoutMs": 5000,
        })
        assert result["exitCode"] == (0 if expected else 1), (profile, result["exitCode"])
        assert (source / "probe").is_file() is expected
    print("Permission canaries: private runtime reads and ADF writes denied; "
          "reader write denied; writer write allowed", flush=True)


async def check_git_permissions(runtime, root):
    source = root / "git-probe"
    repo(source)
    git = "/usr/bin/git"
    remote = root / "git-remote"
    subprocess.run([git, "init", "--bare", "-q", str(remote)], check=True)

    async def run(*command):
        return await runtime.rpc("command/exec", {
            "command": command, "cwd": str(source), "permissionProfile": "adf-writer", "timeoutMs": 15000,
            "env": {"GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"},
        })

    initial = await run(git, "rev-parse", "HEAD")
    assert initial["exitCode"] == 0, initial
    edited = await run("/bin/sh", "-c", "echo 42 > fixture.txt && grep -x 42 fixture.txt")
    assert edited["exitCode"] == 0, edited
    status = await run(git, "status", "--short")
    diff = await run(git, "diff", "--", "fixture.txt")
    assert status["exitCode"] == diff["exitCode"] == 0 and "+42" in diff["stdout"], (status, diff)
    for args in (("add", "--", "fixture.txt"), ("commit", "-m", "test(adf): commit canary")):
        result = await run(git, *args)
        assert result["exitCode"] == 128 and "index.lock" in result["stderr"], result
    pushed = await run(git, "push", str(remote), "HEAD:refs/heads/probe")
    assert pushed["exitCode"] == 128, pushed
    assert subprocess.check_output([git, "--git-dir", str(remote), "for-each-ref"]) == b""
    final = await run(git, "rev-parse", "HEAD")
    assert final["exitCode"] == 0 and final["stdout"] == initial["stdout"], final
    print(f"Developer Git canaries: status/diff allowed, add/commit/push blocked, HEAD={final['stdout'].strip()}",
          flush=True)

    # The test operator supplies the commit by the documented manual workflow.
    subprocess.run([git, "-C", str(source), "-c", "user.name=ADF Test", "-c", "user.email=test@example.invalid",
                    "commit", "-qm", "test(adf): supply reviewed fixture", "--only", "--", "fixture.txt"], check=True)
    revision = subprocess.check_output([git, "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    assert revision != initial["stdout"].strip()
    copied = await snapshot(source, revision, root / "snapshot")
    result = await runtime.rpc("command/exec", {
        "command": runtime_command("python", "print(open('fixture.txt').read().strip())", None, ""),
        "cwd": str(copied), "permissionProfile": "adf-experiment", "timeoutMs": 5000,
    })
    assert result["exitCode"] == 0 and result["stdout"].strip() == "42", result
    print(f"Operator commit {revision}: snapshot ran with fixture.txt=42", flush=True)


async def main(args):
    with tempfile.TemporaryDirectory(prefix="adf-live-") as name:
        root = Path(name)
        store = Store(private_dir(root / "state"))
        service = Service(store, runtime_path())
        try:
            runtime = await service.connect()
            account = await runtime.check_account()
            limits = await service.get_limits()
            print(f"App Server initialized; auth={account['type']}; limits={bool(limits.get('rateLimits'))}", flush=True)
            await check_permissions(runtime, root)
            if args.git_permissions:
                await check_git_permissions(runtime, root)
            if not args.run_turns:
                return
            path = root / "project"
            repo(path)
            project = (await service.register(path))["id"]
            service.set_template(project, "trial", ["/bin/sleep", "35"], 46)
            await service.message(project, "developer",
                                  "Call adf_start_experiment with template trial exactly once. "
                                  "After the tool returns, finish this turn promptly with a short reply. "
                                  "Only that tool is needed. Do not read, change or poll files.",
                                  experiment="trial")
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                await asyncio.sleep(1)
                row = service.session_for(project, "developer")
                if row["state"] in ("interrupted", "quota"):
                    raise AssertionError(f"Runtime stopped: {row['state']}")
                jobs = service.status(project)["jobs"]
                if row["state"] == "idle" and row["turn_requests"] >= 2 and jobs:
                    job = jobs[0]
                    assert job["state"] == "succeeded", job["state"]
                    assert job["waiting_since"] and job["finished"] > job["waiting_since"]
                    assert job["waiting_requests"] == job["initial_requests"] == 1
                    assert job["waiting_tokens"] == job["initial_tokens"] > 0
                    assert row["turn_requests"] == 2
                    assert any(e["speaker"] == "agent" for e in service.conversation(project, "developer"))
                    print(f"turns={row['turn_requests']} wait_new_turns=0 "
                          f"wait_token_delta={job['waiting_tokens'] - job['initial_tokens']} "
                          f"wait_seconds={job['finished'] - job['waiting_since']:.2f}")
                    await service.stop_role(project, "developer")
                    assert service.session_for(project, "developer")["state"] == "paused"
                    await runtime.close()
                    service.runtime = None
                    service.live.clear()
                    runtime = await service.connect()
                    saved = store.session(row["id"])
                    restored = await service.load(saved, service.settings("developer"), runtime)
                    assert restored == row["thread"]
                    print("thread/resume restored the same thread after App Server restart")
                    return
            raise TimeoutError("Live acceptance deadline reached")
        finally:
            await service.stop_all(immediate=True)
            await service.close()
            store.db.close()


if __name__ == "__main__":
    command = argparse.ArgumentParser()
    command.add_argument("--run-turns", action="store_true")
    command.add_argument("--git-permissions", action="store_true")
    asyncio.run(main(command.parse_args()))
