import asyncio
import fcntl
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from adf.service import Service
from adf.store import Store, private_dir
from adf.tracker import checklist
from test_adf import FAKE, repo


class Integration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.path = root / "project"
        repo(self.path)
        self.store = Store(private_dir(root / "state"))
        self.service = Service(self.store, FAKE)
        self.project = (await self.service.register(self.path, github="example/synthetic"))["id"]

    async def asyncTearDown(self):
        await self.service.close()
        self.store.db.close()

    async def test_tracker_approval_duplicate_and_uncertain_send(self):
        payload = {"title": "Research proposal", "body": "- [ ] Test", "priority": "P1"}
        with self.assertRaisesRegex(ValueError, "操作ポリシー"):
            self.service.draft_tracker(self.project, "proposal", payload)
        self.service.set_tracker_policy(self.project, ["proposal", "comment"])
        with self.assertRaisesRegex(ValueError, "ロール"):
            self.service.save_tracker_draft(self.project, "proposal", payload, "developer")
        draft = self.service.save_tracker_draft(self.project, "proposal", payload, "coordinator")
        self.assertEqual(draft, self.service.save_tracker_draft(self.project, "proposal", payload, "coordinator"))
        remote = AsyncMock(return_value=[{"title": "research proposal [AI]", "number": 8}])
        with patch("adf.tracker.gh_api", remote):
            remote.assert_not_awaited()
            result = await self.service.review_tracker(draft, True)
            self.assertEqual(result, {"number": 8, "duplicate": True})
            remote.assert_awaited_once()
            self.assertEqual(remote.await_args.args[1], "GET")
        draft = self.service.draft_tracker(self.project, "comment", {"issue": 8, "body": "test comment"})
        with patch("adf.tracker.perform", AsyncMock(side_effect=TimeoutError)) as sender:
            with self.assertRaises(TimeoutError):
                await self.service.review_tracker(draft, True)
            with self.assertRaisesRegex(ValueError, "送信結果"):
                await self.service.review_tracker(draft, True)
            sender.assert_awaited_once()

    async def test_checkout_policy_is_an_additional_gate(self):
        folder = self.path / "agents"
        folder.mkdir()
        (folder / "config.toml").write_text('[tracker]\nbackend="github"\n[tracker.github]\n'
                                            'repository="example/synthetic"\ncomment="deny"\n')
        self.service.set_tracker_policy(self.project, ["comment"])
        with self.assertRaisesRegex(ValueError, "トラッカーポリシー"):
            self.service.draft_tracker(self.project, "comment", {"issue": 1, "body": "test"})

    def test_checklist_preserves_other_lines(self):
        before = "Summary\r\n- [ ] Verify sample\r\n- [x] Keep\r\n"
        self.assertEqual(checklist(before, "Verify sample", True),
                         "Summary\r\n- [x] Verify sample\r\n- [x] Keep\r\n")
        with self.assertRaises(ValueError):
            checklist(before + "- [ ] Verify sample", "Verify sample", True)

    async def test_legacy_sqlite_owner_blocks_desktop_and_preview_is_safe(self):
        runtime = self.path / "agents/runtime"
        runtime.mkdir(parents=True)
        database = sqlite3.connect(runtime / "adf.sqlite3")
        database.executescript("CREATE TABLE developers(id,owner); CREATE TABLE lifecycle(id,state_json); "
                               "CREATE TABLE jobs(job_id,status,revision); INSERT INTO developers VALUES(1,'legacy'); "
                               "INSERT INTO jobs VALUES('done','succeeded','synthetic');")
        preview = self.service.legacy_preview(self.project)
        self.assertEqual(preview["owner"], "legacy")
        self.assertEqual(preview["jobs"][0]["id"], "done")
        await self.service.message(self.project, "developer", "hold")
        async with asyncio.timeout(3):
            while self.service.session_for(self.project, "developer")["state"] != "interrupted":
                await asyncio.sleep(.02)
        self.assertIsNone(self.service.runtime)
        with self.assertRaisesRegex(ValueError, "停止"):
            self.service.legacy_import(self.project, preview["digest"])
        database.execute("DELETE FROM developers")
        database.commit()
        database.close()
        after = self.service.legacy_preview(self.project)
        with self.assertRaises(ValueError):
            self.service.legacy_import(self.project, preview["digest"])
        result = self.service.legacy_import(self.project, after["digest"])
        self.assertEqual(result["mode"], "archived")
        record = self.service.status(self.project)["legacy_imports"][0]
        self.assertEqual(json.loads(Path(record["path"]).read_text())["jobs"][0]["state"], "succeeded")
        self.assertNotIn("legacy", Path(record["path"]).read_text())
        await self.service.message(self.project, "developer", "hold")
        async with asyncio.timeout(3):
            while not self.service.session_for(self.project, "developer")["turn"]:
                await asyncio.sleep(.02)
        with (runtime / "state.lock").open("rb") as handle:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
