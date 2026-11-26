"""Preset and no-inference queue regression coverage."""

import time
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import test_adf


class ResearchPresets(IsolatedAsyncioTestCase):
    asyncSetUp = test_adf.OrchestratorTest.asyncSetUp
    asyncTearDown = test_adf.OrchestratorTest.asyncTearDown
    state = test_adf.OrchestratorTest.state
    wait = test_adf.OrchestratorTest.wait

    async def test_preview_save_and_override_do_not_change_tracker_policy(self):
        view = self.service.research_preset(self.project, "controlled", tokens=145000, recovery="confirmed")
        self.assertIsNone(self.service.research_preset(self.project))
        with self.assertRaises(ValueError):
            self.service.research_preset(self.project, "controlled", apply=True)
        self.assertEqual(self.service.research_preset(self.project, "controlled", apply=True,
                                                     tokens=145000, recovery="confirmed"), view)
        effective = self.service.research_settings(self.project, jobs=0)
        self.assertEqual((effective["tokens"], effective["jobs"], effective["turns"]), (145000, 0, 8))
        self.assertEqual(self.service.research_preset(self.project)["jobs"], 4)

        with self.store.db:
            self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.service.set_tracker_policy(self.project, {"progress": "allow", "complete": "deny"})
        self.service.research_preset(self.project, "manual", apply=True, tokens=145000)
        issue = {"id": 1, "number": 1, "title": "Test", "body": "", "state": "open",
                 "labels": [{"name": "status:ready"}]}
        with (patch.object(self.service, "load_issue", AsyncMock(return_value=(issue, []))),
              patch("adf.tracker.perform", AsyncMock()) as send):
            await self.service.start_project_research(self.project, [1], "Inspect")
            row = await self.state("developer", "paused")
            self.assertEqual(row["turn_requests"], 0)
            send.assert_not_awaited()
        self.assertEqual(self.service.status(self.project)["tracker_policy"]["progress"], "allow")
        self.assertEqual(self.service.status(self.project)["tracker_policy"]["complete"], "deny")

    async def test_unlimited_queue_waits_without_turns_then_runs_only_approved_task(self):
        dependency = self.service.add_task(self.project, "Prerequisite", "Resolve separately")
        task = self.service.add_task(self.project, "Review", "NO_EXPERIMENT", dependencies=[dependency])
        self.service.research_preset(self.project, "autonomous", apply=True, timeout=21)
        with patch("adf.research.QUEUE_INTERVAL", 0.02):
            await self.service.start_project_research(self.project, [task], "FIXTURE_RESEARCH")
            waiting = await self.state("developer", "waiting")
            self.assertEqual((waiting["turn_requests"], waiting["tokens"]), (0, 0))
            self.assertIsNone(self.service.runtime)
            run = self.service.status(self.project)["research_runs"][0]
            self.assertEqual((run["state"], run["job_limit"], run["turn_limit"], run["token_limit"], run["timeout"]),
                             ("queued", 0, 0, 0, 21))
            await self.service.stop_role(self.project, "developer")
            with self.store.db:
                self.store.db.execute("UPDATE research_task SET state='completed' WHERE id=?", (dependency,))
            stopped = await self.state("developer", "paused")
            self.assertEqual(stopped["turn_requests"], 0)
            await self.service.resume_project_research(self.project)
            completed = await self.wait(lambda: self.service.status(self.project)["research_runs"][0]["state"] == "completed")
        self.assertTrue(completed)
        done = self.service.session_for(self.project, "developer")
        self.assertEqual((done["turn_requests"], done["tokens"]), (1, 17))

    async def test_github_wait_reads_only_until_approved_issue_becomes_ready(self):
        with self.store.db:
            self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.service.set_tracker_policy(self.project, {"progress": "allow", "complete": "deny"})
        issue = {"id": 9, "number": 9, "title": "NO_EXPERIMENT", "body": "", "state": "open", "labels": []}

        async def claim(repository, kind, payload, key, actor):
            self.assertEqual((kind, payload["issue"]), ("progress", 9))
            issue["labels"] = [{"name": "status:in-progress"}]
            return {"number": 9}

        with (patch("adf.research.QUEUE_INTERVAL", 0.02),
              patch.object(self.service, "load_issue", AsyncMock(return_value=(issue, []))) as read,
              patch("adf.tracker.perform", AsyncMock(side_effect=claim)) as send):
            await self.service.start_project_research(self.project, [9], "FIXTURE_RESEARCH", preset="autonomous")
            await self.wait(lambda: read.await_count >= 2)
            self.assertIsNone(self.service.runtime)
            send.assert_not_awaited()
            issue["labels"] = [{"name": "status:ready"}]
            done = await self.state("developer", "paused")
            self.assertEqual(done["turn_requests"], 1)
            send.assert_awaited_once()

    async def test_unlimited_allows_experiment_and_official_recovery_is_preserved(self):
        task = self.service.add_task(self.project, "Calibration", "Check result")
        runtime = await self.service.connect()
        async def account_limits():
            nonlocal calls
            calls += 1
            blocked = calls in (2, 3)
            window = {"usedPercent": 100, "resetsAt": int(time.time()) - 3} if blocked else {"usedPercent": 20}
            return {"rateLimits": {"primary": window}}

        calls = 0
        limits = AsyncMock(side_effect=account_limits)
        with patch.object(runtime, "limits", limits):
            await self.service.start_project_research(self.project, [task], "FIXTURE_RESEARCH", preset="autonomous")
            quota = await self.state("developer", "quota")
            self.assertEqual(quota["turn_requests"], 1)
            self.assertEqual(self.service.status(self.project)["jobs"][0]["wake"], "deferred")
            done = await self.state("developer", "paused")
        self.assertEqual((done["thread"], done["turn_requests"]), (quota["thread"], 3))
        self.assertGreaterEqual(calls, 6)
        self.assertTrue(all(job["wake"] == "sent" for job in self.service.status(self.project)["jobs"]))
