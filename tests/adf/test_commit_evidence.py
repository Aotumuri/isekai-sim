import json
import subprocess
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

import test_adf
from adf.local import GIT_OPERATIONS, git_settings


class GitSettings(TestCase):
    def test_rejects_modes_the_runtime_cannot_enforce(self):
        self.assertEqual(git_settings({}), dict.fromkeys(GIT_OPERATIONS, "deny") | {"require_commit": False})
        for operation in GIT_OPERATIONS:
            for mode in ("allow", "ask"):
                with self.subTest(operation=operation, mode=mode), self.assertRaisesRegex(ValueError, "強制"):
                    git_settings({operation: mode})


class CommitEvidence(IsolatedAsyncioTestCase):
    asyncSetUp = test_adf.OrchestratorTest.asyncSetUp
    asyncTearDown = test_adf.OrchestratorTest.asyncTearDown
    state = test_adf.OrchestratorTest.state
    wait = test_adf.OrchestratorTest.wait

    def git(self, *args):
        return subprocess.check_output(
            ["/usr/bin/git", "-C", str(self.path), "-c", "user.name=ADF Test",
             "-c", "user.email=test@example.invalid", *args], text=True
        ).strip()

    def start(self, scope="FIXTURE_RESEARCH"):
        self.service.local_config = {"git": git_settings({"require_commit": True})}
        first = self.service.add_task(self.project, "Change fixture", "Preserve unrelated staged work")
        second = self.service.add_task(self.project, "Follow up", "NO_EXPERIMENT", dependencies=[first])
        self.service.start_research(self.project, [first, second], scope, files=["fixture.txt"],
                                    jobs=2, turns=5)
        return first, second

    async def test_no_commit_pauses_and_keeps_existing_experiment(self):
        first, second = self.start()
        row = await self.state("developer", "paused")
        data = self.service.status(self.project)
        run = data["research_runs"][0]
        self.assertEqual((run["state"], run["task"]), ("paused", first))
        self.assertEqual(row["turn_requests"], 3)
        self.assertEqual(len(data["jobs"]), 2)
        self.assertTrue(all(task["state"] == "ready" for task in data["research_tasks"]))
        self.assertNotIn(second, [event["detail"] for event in data["events"] if event["kind"] == "research_task"])
        (self.path / "fixture.txt").write_text("reviewed change\n")
        self.git("commit", "-m", "test(adf): change fixture", "--only", "--", "fixture.txt")
        run = self.store.one("SELECT * FROM research_run WHERE session=?", (row["id"],))
        with self.assertRaisesRegex(ValueError, "no successful experiment"):
            await self.service.completion_evidence(self.store.session(row["id"]), run)

    async def test_committed_snapshot_advances_and_next_task_requires_its_own_commit(self):
        prior = self.git("rev-parse", "HEAD")
        (self.path / "unrelated.txt").write_text("staged by human")
        self.git("add", "--", "unrelated.txt")
        original = self.service.before_github_turn

        async def reviewed_commit(row):
            if not row["turn_requests"]:
                (self.path / "fixture.txt").write_text("reviewed change\n")
                self.git("commit", "-m", "test(adf): change fixture", "--only", "--", "fixture.txt")
            return await original(row)

        with patch.object(self.service, "before_github_turn", reviewed_commit):
            first, second = self.start()
            row = await self.state("developer", "paused")
        head = self.git("rev-parse", "HEAD")
        self.assertNotEqual(head, prior)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "unrelated.txt")
        data = self.service.status(self.project)
        self.assertEqual({task["id"]: task["state"] for task in data["research_tasks"]},
                         {first: "completed", second: "ready"})
        run = data["research_runs"][0]
        self.assertEqual((run["state"], run["task"], row["turn_requests"]), ("paused", second, 4))
        self.assertEqual(json.loads(run["scope"])["commit_base"], head)
        for job in data["jobs"]:
            self.assertEqual(job["revision"], head)
            self.assertEqual(job["initial_requests"], job["waiting_requests"])
            self.assertEqual(job["initial_tokens"], job["waiting_tokens"])
            self.assertEqual(job["wake"], "sent")
        result = self.store.one("SELECT detail FROM event WHERE kind='research_result'")
        self.assertEqual(json.loads(result["detail"])["commit"],
                         {"revision": head, "files": ["fixture.txt"]})
