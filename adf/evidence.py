"""Machine checks use the data recorded by the supervisor, not model assertions."""

import asyncio
import json

from .projects import checkpoint
from .runtimes import experiment_command, runtime_stamp
from .snapshots import capture, hashes, scan_dependencies


class Evidence:
    def experiment_inputs(self, job):
        if not isinstance(job, str) or not self.store.one("SELECT 1 FROM job WHERE id=?", (job,)):
            raise ValueError("実験を指定してください")
        path = self.log_path(job).parent / "input/manifest.json"
        if not path.is_file():
            raise ValueError("この実験の入力記録がありません")
        return json.loads(path.read_text())

    async def verified_job(self, row, run):
        scope = json.loads(run["scope"])
        plan = scope.get("experiment") or {}
        artifacts = plan.get("artifacts", [])
        if not artifacts:
            return None
        revision, _ = await checkpoint(row)
        overlay = hashes(capture(row["path"], plan["files"]))
        results = self.store.all(
            "SELECT job.*, rx.program, rx.timeout FROM job JOIN research_experiment rx ON rx.job=job.id "
            "WHERE session=? AND rx.task=? AND initial_requests>? AND state='succeeded' AND exit_code=0 "
            "AND revision=? ORDER BY finished DESC", (row["id"], run["task"], max(run["start_turns"], scope.get("evidence_after", 0)), revision))
        if not results:
            return None
        dependency = plan["dependencies"]
        try:
            environment = await asyncio.to_thread(runtime_stamp, plan["runtime"])
            installation = await asyncio.to_thread(scan_dependencies, row["path"], dependency) if dependency else None
        except (OSError, ValueError):
            return None
        for result in results:
            try:
                manifest = self.experiment_inputs(result["id"])
                recorded = manifest["runtime"]
                script = recorded["script"]
                argv = experiment_command(plan["runtime"], result["program"], script, dependency, result["timeout"])
                if (manifest["overlay"] == overlay and manifest["dependency_source"] == dependency
                        and manifest["dependency_stamp"] == installation
                        and recorded["kind"] == plan["runtime"] and recorded["stamp"] == environment
                        and recorded["argv"] == argv and manifest["conditions"] == {"timeout": result["timeout"]}
                        and result["timeout"] <= run["timeout"]
                        and all(self.artifacts(result["id"], path, size=1)["total"] > 0 for path in artifacts)):
                    return result["id"]
            except (OSError, ValueError, KeyError):
                continue
        return None

    async def finalize_local(self, row, turn):
        run = self.research_for(row)
        if not run:
            return
        plan = json.loads(run["scope"]).get("experiment") or {}
        if (plan.get("artifacts") and run["decision_turn"] == turn
                and json.loads(run["decision"])["outcome"] == "completed"):
            try:
                verified = await self.verified_job(row, run)
            except (OSError, ValueError, TimeoutError):
                verified = None
            if not self.visible(row["id"], row["generation"], ("idle",)):
                return
            if not verified:
                self.pause_github(row, "現在のソースに対応する実験・必須成果物を確認できません")
                return
        self.advance_research(row, turn)
        self.release_inactive_legacy(row["id"])
