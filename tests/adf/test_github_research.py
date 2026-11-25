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
