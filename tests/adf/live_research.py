"""Opt-in live acceptance using only a disposable repository and existing Codex plan."""

import asyncio
from pathlib import Path
import tempfile

from adf.service import Service, runtime_path
from adf.store import Store, private_dir
from live_acceptance import check_permissions
from test_adf import repo


async def main():
    with tempfile.TemporaryDirectory(prefix="adf-research-live-") as folder:
        root = Path(folder)
        store = Store(private_dir(root / "state"))
        service = Service(store, runtime_path())
        try:
            await check_permissions(await service.connect(), root)
            path = root / "project"
            repo(path)
            project = (await service.register(path))["id"]
            service.set_role("developer", effort="low")
            task = service.add_task(project, "Two numerical measurements",
                "Run exactly two adf_research_experiment calls in two separate turns, names trial-a then trial-b. "
                "Use an 8-second monotonic wall-clock loop repeatedly summing squares of the integers 0 to 999. "
                "Each program prints 332833500 and writes 332833500 to result.txt under ADF_ARTIFACTS. "
                "Set each experiment timeout to 18. End the turn immediately after each launch. "
                "After the second result call adf_finish_research_task with outcome completed and the measured result.")
            follow = service.add_task(project, "Independent downstream check",
                "No experiment needed. State why two equal results are reproducible and call adf_finish_research_task "
                "with outcome completed and the checksum 332833500.", dependencies=[task])
            service.start_research(project, [task, follow],
                "Synthetic acceptance only. Use the provided ADF tools; do not edit the work tree, start other "
                "processes, open network connections, or consume external resources.", jobs=2, timeout=20,
                turns=4, tokens=500000)
            async with asyncio.timeout(175):
                while True:
                    await asyncio.sleep(0.5)
                    row = service.session_for(project, "developer")
                    data = service.status(project)
                    if row["state"] not in ("running", "waiting"):
                        break
            run = data["research_runs"][0]
            print("run", run["state"], "session", row["state"], "observed turns", row["turn_requests"],
                  "reported tokens", row["tokens"], flush=True)
            if run["state"] != "completed":
                print([(event["kind"], event["detail"]) for event in data["events"]
                       if event["kind"] in {"error", "job_error", "job_finished", "turn", "research_blocked"}])
                for job in data["jobs"]:
                    print(job["name"], service.read_log(job["id"])[-500:])
            assert row["state"] == "paused" and run["state"] == "completed", (
                [event["kind"] for event in data["events"]], row["state"])
            assert row["turn_requests"] == 4 and row["thread"]
            assert len(data["jobs"]) == 2
            assert all(task["state"] == "completed" for task in data["research_tasks"])
            assert store.one("SELECT count(*) AS total FROM event WHERE session=? AND kind='wake'",
                             (row["id"],))["total"] == 2
            for job in reversed(data["jobs"]):
                assert job["wake"] == "sent" and job["state"] == "succeeded"
                assert job["finished"] > job["waiting_since"]
                assert job["waiting_requests"] == job["initial_requests"]
                assert job["waiting_tokens"] == job["initial_tokens"] > 0
                assert "332833500" in service.read_log(job["id"])
                assert service.artifacts(job["id"], "result.txt")["text"].strip() == "332833500"
                print(job["name"], f"waiting={job['finished'] - job['waiting_since']:.2f}s",
                      "additional_requests=0 token_delta=0 wakes=1 artifact=332833500")
            # The two tasks and both continuations share the initial session.
            first_thread = row["thread"]
            runtime = service.runtime
            await runtime.close()
            service.runtime = None
            service.live.clear()
            assert await service.load(store.session(row["id"]), service.settings("developer"),
                                      await service.connect()) == first_thread
            print("Same thread restored after App Server restart.")
        finally:
            await service.stop_all(immediate=True)
            await service.close()
            store.db.close()


if __name__ == "__main__":
    asyncio.run(main())
