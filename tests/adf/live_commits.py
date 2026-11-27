"""Opt-in real Developer commit acceptance using a disposable Git repository."""

import asyncio
import json
from pathlib import Path
import subprocess
import tempfile

from adf.codex import COMMIT_PROFILE
from adf.local import bind_project, read_config
from adf.service import Service, runtime_path
from adf.store import Store, private_dir
from test_adf import repo


async def check_boundaries(runtime, path, root):
    for name in ("adf/launcher.py", "adf/runtime/config.toml", "adf/runtime/state.sqlite", "adf/runtime/ipc"):
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("protected")
    secret = root / "auth.canary"
    secret.write_text("protected")
    remote = root / "remote.git"
    subprocess.run(["/usr/bin/git", "init", "-q", "--bare", str(remote)], check=True)
    async def respond(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()

    listener = await asyncio.start_server(respond, "127.0.0.1", 0)
    async with listener:
        address = f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}"
        result = await runtime.rpc("command/exec", {
            "cwd": str(path), "permissionProfile": COMMIT_PROFILE, "timeoutMs": 12000,
            "command": ["/bin/sh", "-c",
                        'for file in adf/launcher.py adf/runtime/config.toml adf/runtime/state.sqlite '
                        'adf/runtime/ipc .git/config .git/hooks/commit-msg; do '
                        'if (echo changed >> "$file") 2>/dev/null; then exit 91; fi; done; '
                        'if test -r "$1" || test -r adf/runtime/config.toml; then exit 92; fi; '
                        'if /usr/bin/git push "$2" HEAD:refs/heads/probe >/dev/null 2>&1; then exit 93; fi; '
                        'if /usr/bin/curl -s --max-time 2 "$3" >/dev/null; then exit 94; fi; '
                        'exit 0', "probe", str(secret), str(remote), address],
        })
    assert result["exitCode"] == 0, result
    assert subprocess.check_output(["/usr/bin/git", "--git-dir", str(remote), "for-each-ref"]) == b""
    print("Commit profile: ADF files, Git config/hooks, runtime, external auth, push and networking protected",
          flush=True)


async def main():
    with tempfile.TemporaryDirectory(prefix="adf-live-commits-") as name:
        root = Path(name).resolve()
        path = root / "project"
        repo(path)

        def git(*args):
            return subprocess.check_output(["/usr/bin/git", "-C", str(path), *args], text=True).strip()

        git("config", "user.name", "ADF Live Acceptance")
        git("config", "user.email", "adf-test@example.invalid")
        git("config", "maintenance.auto", "false")
        git("config", "gc.auto", "0")
        git("config", "commit.gpgsign", "false")  # Synthetic repository has no signing identity.
        hook = path / ".git/hooks/commit-msg"
        hook.write_text("#!/bin/sh\nexec /usr/bin/grep -q '^test(adf): ' \"$1\"\n")
        hook.chmod(0o700)
        (path / ".git/info/exclude").write_text("/adf/\n")
        base = git("rev-parse", "HEAD")
        (path / "operator.txt").write_text("untouched operator work\n")
        config = root / "config.toml"
        config.write_text('[git]\ncommit = "allow"\n')
        store = Store(private_dir(root / "state"))
        service = Service(store, runtime_path())
        on_tool = service.on_tool

        async def trace_tool(params):
            result = await on_tool(params)
            if not result[0]:
                print(f"{params['tool']} rejected ({sorted(params['arguments'])}): {result[1]}", flush=True)
            return result

        service.on_tool = trace_tool
        try:
            await bind_project(service, path, read_config(config))
            await check_boundaries(await service.connect(), path, root)
            project = service.local_project
            service.set_role("developer", effort="low")
            tasks = []
            for filename, value in (("fixture.txt", "42"), ("second.txt", "43")):
                experiment = json.dumps({
                    "name": f"Measure {filename}", "timeout": 26,
                    "program": ("import os, time\nfrom pathlib import Path\n"
                                f"value = Path({filename!r}).read_text().strip()\nassert value == {value!r}\n"
                                "time.sleep(18)\nPath(os.environ['ADF_ARTIFACTS'], 'result.txt').write_text(value)"),
                })
                tasks.append(service.add_task(
                    project, f"Commit and measure {filename}",
                    f"Set {filename} to exactly {value} followed by a newline. Verify it with grep. "
                    f"Stage only {filename} using git add, review the staged paths, and make an ordinary "
                    "git commit with a message starting with 'test(adf): '. Verify HEAD and the committed paths. "
                    f"Call adf_research_experiment with exactly these arguments: {experiment}. "
                    "End the turn immediately after accepting the experiment. On wake, read result.txt "
                    "with adf_read_experiment_output and call adf_finish_research_task with the observed value.",
                    dependencies=tasks.copy(),
                ))
            service.start_research(project, tasks, "Disposable acceptance fixture. Keep operator.txt intact.",
                                   files=["fixture.txt", "second.txt"], evidence=["result.txt"],
                                   jobs=2, turns=4, timeout=26, tokens=500000)
            async with asyncio.timeout(210):
                while (row := service.session_for(project, "developer"))["state"] in ("running", "waiting", "idle"):
                    await asyncio.sleep(0.5)
            data = service.status(project)
            run = data["research_runs"][0]
            if run["state"] != "completed":
                print([(e["kind"], e["detail"]) for e in data["events"]
                       if e["kind"] in {"error", "job_error", "turn", "paused", "research_blocked"}], flush=True)
                print(f"turns={row['turn_requests']} observed_tokens={row['tokens']}", flush=True)
                print(service.conversation(project, "developer")[-5:], flush=True)
            assert run["state"] == "completed" and row["turn_requests"] == 4, (run["state"], row["state"])
            commits = git("rev-list", "--reverse", f"{base}..HEAD").splitlines()
            assert len(commits) == 2
            assert git("status", "--short") == "?? operator.txt"
            assert (path / "operator.txt").read_text() == "untouched operator work\n"
            jobs = list(reversed(data["jobs"]))
            assert len(jobs) == 2
            for commit, job, filename, value in zip(commits, jobs, ("fixture.txt", "second.txt"), ("42", "43")):
                assert git("show", "--pretty=format:", "--name-only", commit) == filename
                assert job["state"] == "succeeded" and job["wake"] == "sent" and job["revision"] == commit
                assert service.experiment_inputs(job["id"])["revision"] == commit
                assert service.artifacts(job["id"], "result.txt")["text"] == value
                assert job["finished"] > job["waiting_since"]
                assert job["initial_requests"] == job["waiting_requests"]
                assert job["initial_tokens"] == job["waiting_tokens"] > 0
                print(f"commit={commit} file={filename} result={value} "
                      f"wait={job['finished'] - job['waiting_since']:.2f}s additional_turns=0 additional_tokens=0",
                      flush=True)
            assert {turn["thread"] for turn in store.all("SELECT thread FROM turn_usage")} == {row["thread"]}
            decisions = store.all("SELECT detail FROM event WHERE kind='research_result' ORDER BY id")
            assert [json.loads(item["detail"])["commit"]["revision"] for item in decisions] == commits
            assert all(task["state"] == "completed" for task in data["research_tasks"])
            print(f"Verified both tasks on one thread, {row['turn_requests']} turns; HEAD={commits[-1]}", flush=True)
        finally:
            await service.stop_all(immediate=True)
            await service.close()
            store.db.close()


if __name__ == "__main__":
    asyncio.run(main())
