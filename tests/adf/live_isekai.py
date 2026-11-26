"""Opt-in acceptance using the actual simulator and its offline Node tools."""

import argparse
import asyncio
import io
import json
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from adf.projects import snapshot
from adf.runtimes import experiment_command, prepare_node, runtime_stamp
from adf.service import Service, runtime_path
from adf.snapshots import capture, prepare_inputs
from adf.store import Store, private_dir

SCRIPT = '''import { register } from "tsx/esm/api";
import { after } from "node:test";
import { writeFileSync } from "node:fs";
register();
after(async () => {
  await new Promise(resolve => setTimeout(resolve, 7000));
  writeFileSync(process.env.ADF_ARTIFACTS + "/simulation.json", JSON.stringify({suite:"simulation",rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed}));
});
await import("./test/regression/simulation.test.ts");
'''


def make_fixture(root):
    root.mkdir()
    archive = subprocess.check_output(["git", "archive", "HEAD", "src", "test", "package.json",
                                       "package-lock.json", "tsconfig.test.json", "tsconfig.json"])
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        bundle.extractall(root, filter="data")
    for args in (("init", "-q"), ("add", "."),
                 ("-c", "user.name=ADF Fixture", "-c", "user.email=adf@example.invalid",
                  "-c", "commit.gpgsign=false", "commit", "-qm", "Simulator fixture")):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(root), *args], check=True)
    modules = Path("node_modules").resolve()
    target = root / "node_modules"
    shutil.copytree(modules, target, symlinks=True, ignore=shutil.ignore_patterns(".bin", "tsx", ".cache"))
    tsx = (modules / "tsx").resolve(strict=True)
    assert json.loads((tsx / "package.json").read_text())["name"] == "tsx"
    shutil.copytree(tsx, target / "tsx", symlinks=True)
    for package in ("get-tsconfig", "resolve-pkg-maps", "esbuild", "@esbuild/darwin-arm64"):
        dependency = tsx.parent / package
        assert json.loads((dependency / "package.json").read_text())["name"] == package
        shutil.copytree(dependency, target / "tsx/node_modules" / package, symlinks=True)
    return subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()


async def command_trial(root, path, revision, runtime):
    name = "adf-acceptance.mjs"
    (path / name).write_text(SCRIPT)
    source = await snapshot(path, revision, root / "command-trial")
    stamp = await asyncio.to_thread(runtime_stamp, "node")
    info = await asyncio.to_thread(prepare_node, source)
    args = experiment_command("node", None, name, "node_modules", 40)
    info.update(stamp=stamp, script=name, argv=args)
    plan = {"runtime": "node", "dependencies": "node_modules"}
    await asyncio.to_thread(prepare_inputs, source, path, plan, capture(path, [name]), revision, info)
    (source / ".adf-artifacts").mkdir()
    result = await runtime.rpc("command/exec", {
        "command": args, "cwd": str(source), "permissionProfile": "adf-node", "timeoutMs": 40000,
        "env": {"ADF_ARTIFACTS": str(source / ".adf-artifacts"), "HOME": str(source), "TMPDIR": str(source)},
    }, timeout=45)
    assert result["exitCode"] == 0, result
    assert (source / ".adf-artifacts/simulation.json").is_file()
    print("Offline sandbox: actual simulation regression suite and npm dependencies passed.", flush=True)
    print((source / ".adf-artifacts/simulation.json").read_text(), flush=True)


async def model_trial(path, service):
    project = (await service.register(path))["id"]
    service.set_role("developer", effort="low")
    coordinator = service.reserve(project, "coordinator", "Acceptance session", False, launch=False)
    runtime = await service.connect()
    coordinator_thread = await service.load(service.store.session(coordinator), service.settings("coordinator"), runtime)
    with service.store.db:
        service.store.update_session(coordinator, state="idle")
    name = "adf-acceptance.mjs"
    task = service.add_task(project, "Simulator regression acceptance",
                            "Create the approved script from the user scope, then run it using "
                            "adf_research_experiment with script adf-acceptance.mjs and timeout 40. "
                            "End the turn promptly. After the automated wake, evaluate and "
                            "call adf_finish_research_task with outcome completed if the run succeeded.")
    service.start_research(project, [task], "Synthetic checkout only. Write this exact new script at repository root "
                           "and start it. Do not edit any other files:\n" + SCRIPT,
                           jobs=1, turns=2, timeout=40, tokens=400000, runtime="node", files=[name],
                           dependencies="node_modules", evidence=["simulation.json"])
    async with asyncio.timeout(160):
        while service.session_for(project, "developer")["state"] in {"running", "waiting", "idle"}:
            await asyncio.sleep(.4)
    data = service.status(project)
    row = service.session_for(project, "developer")
    assert data["research_runs"][0]["state"] == "completed", [
        e["detail"] for e in data["events"] if e["kind"] in {"job_error", "error", "research_blocked", "github_pause"}]
    job, = data["jobs"]
    assert job["state"] == "succeeded" and job["wake"] == "sent"
    assert job["finished"] > job["waiting_since"]
    assert job["waiting_requests"] == job["initial_requests"] == 1
    assert job["waiting_tokens"] == job["initial_tokens"] > 0
    assert row["turn_requests"] == 2 and row["thread"]
    coordinator_state = service.store.session(coordinator)
    assert coordinator_state["state"] == "idle" and coordinator_state["turn_requests"] == 0
    assert coordinator_state["thread"] == coordinator_thread != row["thread"]
    wakes = service.store.one("SELECT count(*) AS n FROM event WHERE session=? AND kind='wake'", (row["id"],))
    assert wakes["n"] == 1
    output = json.loads(service.artifacts(job["id"], "simulation.json")["text"])
    assert output["suite"] == "simulation"
    log = service.read_log(job["id"])
    assert re.search(r"^(?:#|ℹ) pass 4\s*$", log, re.MULTILINE), log[-1200:]
    assert (path / name).read_bytes() == (service.log_path(job["id"]).parent / "input/overlay" / name).read_bytes()
    print(json.dumps(output), flush=True)
    usage = service.usage_report(project)["turns"]
    assert len({turn["thread"] for turn in usage}) == 1
    print(f"wait={job['finished'] - job['waiting_since']:.2f}s, requests=0, tokens=0, wakes=1, turns=2")


async def main(model):
    with tempfile.TemporaryDirectory(prefix="adf-actual-sim-") as name:
        root = Path(name)
        path = root / "project"
        revision = await asyncio.to_thread(make_fixture, path)
        store = Store(private_dir(root / "state"))
        service = Service(store, runtime_path())
        try:
            if model:
                await model_trial(path, service)
            else:
                await command_trial(root, path, revision, await service.connect())
        finally:
            await service.stop_all(immediate=True)
            await service.close()
            store.db.close()


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    mode = cli.add_mutually_exclusive_group()
    mode.add_argument("--turns", action="store_true")
    mode.add_argument("--prepare", type=Path, metavar="NEW_DIRECTORY")
    args = cli.parse_args()
    if args.prepare:
        revision = make_fixture(args.prepare.resolve())
        (args.prepare / "adf-acceptance.mjs").write_text(SCRIPT)
        print(f"GUI fixture: {args.prepare.resolve()} ({revision})")
    else:
        asyncio.run(main(args.turns))
