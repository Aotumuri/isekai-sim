"""Opt-in production workflow smoke using installed TypeScript and Codex."""

import argparse
import asyncio
from pathlib import Path
import shutil
import tempfile

from adf.runtimes import prepare_node, runtime_command
from adf.service import Service, runtime_path
from adf.store import Store, private_dir
from test_adf import repo


async def main(args):
    with tempfile.TemporaryDirectory(prefix="adf-node-") as name:
        root = Path(name)
        path = root / "project"
        repo(path)
        deps = path / "node_modules"
        deps.mkdir()
        shutil.copytree(args.typescript, deps / "typescript")
        script = path / "calculate.cjs"
        script.write_text(
            'const ts=require("typescript"),fs=require("node:fs"); '
             'const source=ts.transpileModule("let n: number = 1000", {compilerOptions:{module:ts.ModuleKind.None}}); '
            'if(!source.outputText.includes("1000")) throw Error("TypeScript transpilation failed"); '
            'const end=Date.now()+9000; let checksum=0; '
            'while(Date.now()<end){checksum=0; for(let i=0;i<1000;i++) checksum+=i*i;} '
            'const out=JSON.stringify({checksum, version:ts.version}); '
            'fs.writeFileSync(process.env.ADF_ARTIFACTS+"/result.json",out); console.log(out);')
        store = Store(private_dir(root / "state"))
        service = Service(store, runtime_path())
        try:
            runtime = await service.connect()
            source = root / "sandbox"
            source.mkdir()
            await asyncio.to_thread(prepare_node, source)
            result = await runtime.rpc("command/exec", {
                "command": runtime_command("node", 'console.log(process.versions.node)', None, ""),
                "cwd": str(source), "permissionProfile": "adf-node", "timeoutMs": 6000})
            assert result["exitCode"] == 0, result
            print("Node App Server smoke:", result["stdout"].strip(), flush=True)
            if not args.turns:
                return
            project = (await service.register(path))["id"]
            service.set_role("developer", effort="low")
            task = service.add_task(project, "Check Node with TypeScript", "Start exactly one adf_research_experiment "
                                    "with name node-check, script calculate.cjs, timeout 20. The approved untracked "
                                    "source already exists. End the turn promptly. On result, call "
                                    "adf_finish_research_task with outcome completed and describe the checksum.")
            service.start_research(project, [task], "Synthetic calculation only. Do not edit files or start other "
                                   "processes. Call the approved tool.", jobs=1, turns=2, timeout=20, tokens=300000,
                                   runtime="node", files=["calculate.cjs"], dependencies="node_modules",
                                   evidence=["result.json"])
            async with asyncio.timeout(130):
                while service.session_for(project, "developer")["state"] in {"running", "waiting", "idle"}:
                    await asyncio.sleep(.4)
            row = service.session_for(project, "developer")
            data = service.status(project)
            assert len(data["jobs"]) == 1, (row["state"], [e["detail"] for e in data["events"]
                                                          if e["kind"] == "error"])
            job = data["jobs"][0]
            assert data["research_runs"][0]["state"] == "completed", (
                row["state"], job["state"], service.read_log(job["id"]),
                [e["detail"] for e in data["events"] if e["kind"] in {"error", "job_error", "research_blocked"}])
            assert job["finished"] > job["waiting_since"]
            assert job["waiting_requests"] == job["initial_requests"] == 1
            assert job["waiting_tokens"] == job["initial_tokens"] > 0
            assert job["wake"] == "sent" and row["turn_requests"] == 2
            assert store.one("SELECT count(*) AS n FROM event WHERE kind='wake'")["n"] == 1
            assert (service.log_path(job["id"]).parent / "input/overlay/calculate.cjs").read_bytes() == script.read_bytes()
            output = service.artifacts(job["id"], "result.json")["text"]
            assert "332833500" in output, output
            print(f"wait={job['finished'] - job['waiting_since']:.2f}s, requests=0, tokens=0, wakes=1")
            print(output)
            for turn in service.usage_report(project)["turns"]:
                print("Turn", turn["sequence"], turn["delta"])
            print("Observed cumulative tokens", row["tokens"])
        finally:
            await service.stop_all(immediate=True)
            await service.close()
            store.db.close()


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--typescript", type=Path, required=True)
    cli.add_argument("--turns", action="store_true")
    asyncio.run(main(cli.parse_args()))
