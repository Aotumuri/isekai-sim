"""Explicit opt-in bounded acceptance against the signed-in local Codex."""

import argparse
import asyncio
from pathlib import Path
import tempfile
import time

from adf.service import Service, runtime_path
from adf.store import Store, private_dir
from test_adf import repo


async def check_permissions(runtime, root):
    source = root / "security"
    source.mkdir()
    outside = root / "canary"
    outside.write_text("canary")
    (source / ".env").write_text("canary")
    for profile, expected in (("adf-reader", False), ("adf-writer", True)):
        # Use only synthetic files and test declared access with a trusted fixed command.
        result = await runtime.rpc("command/exec", {
            "command": ["/bin/sh", "-c",
                        'test ! -r "$1" && test ! -r .env || exit 91; '
                        'if (echo ok > probe) 2>/dev/null; then exit 0; else exit 1; fi',
                        "sh", str(outside)],
            "cwd": str(source), "permissionProfile": profile, "timeoutMs": 5000,
        })
        assert result["exitCode"] == (0 if expected else 1), (profile, result["exitCode"])
        assert (source / "probe").is_file() is expected
    print("Permission canaries: outside read denied; reader write denied; writer write allowed", flush=True)


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
                    assert row["turn_requests"] == 2
                    assert any(e["kind"] == "assistant" for e in service.status(project)["events"])
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
    asyncio.run(main(command.parse_args()))
