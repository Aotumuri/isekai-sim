import asyncio
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import test_adf


class TestGitHubResearch(IsolatedAsyncioTestCase):
    asyncSetUp = test_adf.OrchestratorTest.asyncSetUp
    asyncTearDown = test_adf.OrchestratorTest.asyncTearDown
    state = test_adf.OrchestratorTest.state
    wait = test_adf.OrchestratorTest.wait
    async def test_dependency_pinned_issue_claim_complete_and_continue(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"progress": "allow", "complete": "allow"})
        issues = {n: {"id": n, "title": f"NO_EXPERIMENT {n}", "body": "", "number": n, "state": "open",
                      "labels": [{"name": "status:ready"}, {"name": f"priority:p{3 - n}"}]} for n in (1, 2)}
        trace = []

        async def fetch(repo, issue):
            return issues[issue]

        async def api(repo, method, endpoint, **kwargs):
            return [issues[1]] if "/2/" in endpoint else []

        async def send(repo, kind, payload, key, actor):
            n = payload["issue"]
            trace.append((kind, n))
            if kind == "complete":
                issues[n].update(state="closed", state_reason="completed")
            else:
                issues[n]["labels"] = [{"name": "status:in-progress"}]
            return {"number": n}

        with (patch("adf.github_research.fetch_issue", fetch), patch("adf.github_research.gh_api", api),
              patch("adf.tracker.perform", send),
              patch.object(self.service, "verified_job", AsyncMock(return_value="verified-fixture"))):
            await self.service.start_project_research(self.project, [2, 1], "FIXTURE_RESEARCH",
                                                      jobs=2, turns=4)
            row = await self.state("developer", "paused")
        self.assertEqual(trace, [("progress", 1), ("complete", 1), ("progress", 2), ("complete", 2)])
        self.assertEqual(row["turn_requests"], 2)
        self.assertEqual(self.service.status(self.project)["research_tasks"], [])

    async def test_more_restrictive_repo_policy_applies_to_allow(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        (self.path / "agents").mkdir()
        (self.path / "agents/config.toml").write_text('[tracker]\nbackend="github"\n[tracker.github]\n'
                                                     'repository="fixture/project"\nupdate_issue="ask"\ncomment="deny"\n')
        self.service.set_tracker_policy(self.project, {"progress": "allow", "comment": "allow"})
        project = self.service.project(self.project)
        self.assertEqual(self.service.tracker_policy(project, "progress"), "ask")
        self.assertEqual(self.service.tracker_policy(project, "comment"), "deny")

    async def test_ask_blocks_inference_and_external_edit_invalidates_approval(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"progress": "ask", "complete": "allow"})
        remote = {"id": 1, "number": 1, "title": "original", "body": "", "state": "open",
                  "labels": [{"name": "status:ready"}]}
        with (patch.object(self.service, "load_issue", new=AsyncMock(return_value=(remote, []))),
              patch("adf.tracker.perform", new=AsyncMock()) as send):
            await self.service.start_project_research(self.project, [1], "Read and evaluate")
            row = await self.state("developer", "paused")
            self.assertEqual(row["turn_requests"], 0)
            draft = self.service.status(self.project)["tracker_operations"][0]
            remote["body"] = "External change after approval request"
            with self.assertRaisesRegex(ValueError, "変更"):
                await self.service.review_tracker(draft["id"], True)
            send.assert_not_awaited()


    async def test_stop_prevents_launch_during_remote_selection(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"progress": "allow"})
        entered = asyncio.Event()
        proceed = asyncio.Event()

        async def select(*args):
            entered.set()
            await proceed.wait()
            return None, False

        with patch.object(self.service, "select_issue", select):
            pending = asyncio.create_task(self.service.start_project_research(self.project, [1], "Evaluate"))
            await entered.wait()
            await self.service.stop_role(self.project, "developer")
            proceed.set()
            with self.assertRaisesRegex(ValueError, "停止"):
                await pending
        self.assertIsNone(self.service.session_for(self.project, "developer"))

    async def test_stop_expires_and_resume_recreates_claim_approval(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"progress": "ask"})
        issue = {"id": 1, "number": 1, "title": "Test", "body": "", "state": "open",
                 "labels": [{"name": "status:ready"}]}
        with patch.object(self.service, "load_issue", AsyncMock(return_value=(issue, []))):
            await self.service.start_project_research(self.project, [1], "Inspect")
            await self.state("developer", "paused")
            old = self.service.status(self.project)["tracker_operations"][0]["id"]
            await self.service.stop_role(self.project, "developer")
            with self.assertRaises(ValueError):
                await self.service.review_tracker(old, True)
            await self.service.resume_project_research(self.project)
            row = await self.state("developer", "paused")
        operations = self.service.status(self.project)["tracker_operations"]
        self.assertEqual([item["state"] for item in operations], ["pending", "expired"])
        self.assertEqual(row["turn_requests"], 0)

    async def test_crash_expires_pending_claim_but_preserves_ambiguous_send(self):
        with self.store.db:
            self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.service.set_tracker_policy(self.project, {"progress": "ask"})
        issue = {"id": 1, "number": 1, "title": "Test", "body": "", "state": "open",
                 "labels": [{"name": "status:ready"}]}
        with (patch.object(self.service, "load_issue", AsyncMock(return_value=(issue, []))),
              patch("adf.tracker.perform", AsyncMock()) as send):
            await self.service.start_project_research(self.project, [1], "Inspect")
            row = await self.state("developer", "paused")
            old = self.service.status(self.project)["tracker_operations"][0]["id"]
            home = self.store.home
            self.store.db.close()
            self.store = test_adf.Store(home)
            self.service.store = self.store
            self.store.recover()
            recovered = self.store.session(row["id"])
            self.assertEqual((recovered["state"], recovered["generation"], recovered["turn_requests"]),
                             ("interrupted", row["generation"] + 1, 0))
            with self.assertRaises(ValueError):
                await self.service.review_tracker(old, True)
            await self.service.resume_project_research(self.project)
            await self.state("developer", "paused")
            latest = self.service.status(self.project)["tracker_operations"]
            self.assertEqual([entry["state"] for entry in latest], ["pending", "expired"])
            self.assertNotEqual(latest[0]["id"], old)

            # A sent request with unknown outcome must stay blocked across another restart.
            with self.store.db:
                self.store.db.execute("UPDATE tracker_operation SET state='sending' WHERE id=?", (latest[0]["id"],))
            self.store.recover()
            with self.assertRaisesRegex(ValueError, "送信結果"):
                await self.service.resume_project_research(self.project)
            self.assertEqual(self.service.status(self.project)["tracker_operations"][0]["state"], "sending")
            send.assert_not_awaited()
            self.assertEqual(self.store.session(row["id"])["turn_requests"], 0)

    async def test_quota_resume_does_not_repeat_confirmed_claim(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"progress": "allow", "complete": "ask"})
        issue = {"id": 1, "number": 1, "title": "NO_EXPERIMENT", "body": "", "state": "open",
                 "labels": [{"name": "status:ready"}]}
        runtime = await self.service.connect()
        rate_limit = AsyncMock(side_effect=[
            {"rateLimits": {"primary": {"usedPercent": 100}}},
            {"rateLimits": {"primary": {"usedPercent": 20}}},
        ])

        async def claim(repo, kind, payload, key, actor):
            self.assertEqual(kind, "progress")
            issue["labels"] = [{"name": "status:in-progress"}]
            return {"number": 1}

        with (patch.object(self.service, "load_issue", AsyncMock(return_value=(issue, []))),
              patch.object(runtime, "limits", rate_limit), patch("adf.tracker.perform", AsyncMock(side_effect=claim)) as send):
            await self.service.start_project_research(self.project, [1], "FIXTURE_RESEARCH")
            quota = await self.state("developer", "quota")
            self.assertEqual(quota["turn_requests"], 0)
            self.assertIsNone(quota["thread"])
            await self.service.resume_project_research(self.project)
            paused = await self.state("developer", "paused")
        self.assertIsNotNone(paused["thread"])
        self.assertEqual(paused["turn_requests"], 1)
        send.assert_awaited_once()

    async def test_recovered_confirmed_completion_can_continue_without_resend(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"progress": "allow", "complete": "ask"})
        issues = {n: {"id": n, "number": n, "title": f"NO_EXPERIMENT {n}", "body": "", "state": "open",
                      "labels": [{"name": "status:ready"}]} for n in (1, 2)}
        sent = []

        async def load(repo, number):
            return issues[number], [issues[1]] if number == 2 else []

        async def mutate(repo, kind, payload, key, actor):
            number = payload["issue"]
            sent.append((kind, number))
            if kind == "complete":
                issues[number].update(state="closed", state_reason="completed")
            else:
                issues[number]["labels"] = [{"name": "status:in-progress"}]
            return {"number": number}

        with (patch.object(self.service, "load_issue", load), patch("adf.tracker.perform", mutate)):
            await self.service.start_project_research(self.project, [1, 2], "FIXTURE_RESEARCH")
            row = await self.state("developer", "paused")
            operation = self.service.github_run(row)["operation"]
            await self.service.review_tracker(operation, True)
            with self.store.db:
                self.store.update_session(row["id"], state="idle")
            self.store.recover()
            self.assertEqual(self.store.session(row["id"])["state"], "interrupted")
            await self.service.resume_project_research(self.project)
            follow = await self.state("developer", "paused")
        self.assertEqual(follow["turn_requests"], 2)
        self.assertEqual(sent, [("progress", 1), ("complete", 1), ("progress", 2)])
