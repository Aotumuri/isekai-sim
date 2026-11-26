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
        if not artifacts and not plan.get("require_commit"):
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

    async def completion_evidence(self, row, run, decision=None, *, optional_job=False):
        scope = json.loads(run["scope"])
        plan = scope.get("experiment") or {}
        proof = None
        if plan.get("require_commit"):
            expected = decision.get("commit") if decision is not None else None
            if decision is not None and not expected:
                raise ValueError("The saved decision has no verified commit.")
            proof = await self.verified_commit(row, scope, expected["revision"] if expected else None)
        job = await self.verified_job(row, run) if proof or plan.get("artifacts") or optional_job else None
        if (proof or plan.get("artifacts")) and not job:
            raise ValueError("The current source has no successful experiment with all required artifacts.")
        if proof:
            recorded = self.store.one("SELECT revision FROM job WHERE id=?", (job,))
            if recorded["revision"] != proof["revision"] or (await checkpoint(row))[0] != proof["revision"]:
                raise ValueError("HEAD changed during commit and experiment verification.")
        return proof, job

    async def finalize_local(self, row, turn):
        run = self.research_for(row)
        if not run:
            return
        plan = json.loads(run["scope"]).get("experiment") or {}
        if plan.get("require_commit") and run["decision_turn"] != turn:
            self.pause_research(row, "コミットと実験の証拠を確認できません。差分と実験記録を確認して再開してください")
            return
        if run["decision_turn"] == turn and json.loads(run["decision"])["outcome"] == "completed":
            try:
                await self.completion_evidence(row, run, json.loads(run["decision"]))
            except (OSError, ValueError, TimeoutError) as error:
                self.pause_research(row, str(error) if isinstance(error, ValueError) else type(error).__name__)
                return
            if not self.visible(row["id"], row["generation"], ("idle",)):
                return
        self.advance_research(row, turn)
        self.release_inactive_legacy(row["id"])
