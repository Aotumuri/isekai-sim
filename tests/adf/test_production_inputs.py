import asyncio
import json
from pathlib import Path
import subprocess
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import test_adf
from adf.snapshots import capture


class Inputs(IsolatedAsyncioTestCase):
    asyncSetUp = test_adf.OrchestratorTest.asyncSetUp
    asyncTearDown = test_adf.OrchestratorTest.asyncTearDown
    state = test_adf.OrchestratorTest.state
    wait = test_adf.OrchestratorTest.wait

    async def test_worktree_overlay_dependencies_and_mechanical_evidence(self):
        prior = self.path / "fixture.txt"
        prior.write_text("Prior user changes\n")
        new = self.path / "experiment.py"
        libs = self.path / "offline"
        libs.mkdir()
        (libs / "number.py").write_text("VALUE = 42")
        task = self.service.add_task(self.project, "Input snapshot", "FIXTURE_RESEARCH")
        original = self.service.design_experiment

        def select_program(row, args):
            return original(row, {"name": "test", "script": "experiment.py", "timeout": 5})

        with patch.object(self.service, "design_experiment", select_program):
            self.service.start_research(self.project, [task], "FIXTURE_RESEARCH", jobs=2, turns=4,
                                        files=["experiment.py", "fixture.txt"], dependencies="offline",
                                        evidence=["result.txt"])
            # Model is represented by the fixture. Files are written only after scope capture.
            new.write_text("from number import VALUE\n"
                           "import os,time,pathlib\n"
                           "time.sleep(.25)\n"
                           "pathlib.Path(os.environ['ADF_ARTIFACTS'], 'result.txt').write_text(str(VALUE))\n")
            row = await self.state("developer", "paused")
        data = self.service.status(self.project)
        self.assertEqual(data["research_runs"][0]["state"], "completed")
        self.assertEqual(row["turn_requests"], 3)
        job = data["jobs"][0]
        self.assertEqual(self.service.artifacts(job["id"], "result.txt")["text"], "42")
        record = self.service.experiment_inputs(job["id"])
        self.assertIn("sha256", record["overlay"]["experiment.py"])
        self.assertIn("number.py", record["dependencies"])
        preview = await self.service.commit_preview(self.project)
        self.assertEqual(preview["excluded_prior_changes"], ["fixture.txt"])
        self.assertEqual([item["path"] for item in preview["files"]], ["experiment.py"])
        self.assertEqual(prior.read_text(), "Prior user changes\n")
        with self.assertRaises(ValueError):
            capture(self.path, [".env.secret"])
        (self.path / "link").symlink_to(self.path / "experiment.py")
        with self.assertRaises(OSError):
            capture(self.path, ["link"])
        usage = self.service.usage_report(self.project)
        self.assertEqual(len(usage["turns"]), 3)
        self.assertEqual(len(usage["experiment_evaluations"]), 2)
        self.assertEqual(usage["turns"][-1]["delta"]["totalTokens"], 17)


    async def test_self_report_is_insufficient_when_evidence_is_required(self):
        task = self.service.add_task(self.project, "Test evidence", "NO_EXPERIMENT")
        self.service.start_research(self.project, [task], "FIXTURE_RESEARCH", turns=2, evidence=["required.json"])
        row = await self.state("developer", "paused")
        self.assertEqual(row["turn_requests"], 1)
        data = self.service.status(self.project)
        self.assertEqual(data["research_runs"][0]["state"], "blocked")
        self.assertEqual(data["research_tasks"][0]["state"], "ready")
