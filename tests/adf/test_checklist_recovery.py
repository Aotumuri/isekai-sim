"""Tests at the actual outbox boundary, with a synthetic remote issue."""

import asyncio
from copy import deepcopy
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from adf.github_research import fingerprint
from adf.tracker import checklist
import test_adf


class ChecklistRecovery(IsolatedAsyncioTestCase):
    asyncSetUp = test_adf.OrchestratorTest.asyncSetUp
    asyncTearDown = test_adf.OrchestratorTest.asyncTearDown

    def pin(self):
        self.store.db.execute("UPDATE project SET github='fixture/project' WHERE id=?", (self.project,))
        self.store.db.commit()
        self.service.set_tracker_policy(self.project, {"checklist": "allow", "complete": "allow"})
        self.issue = {"id": 4, "number": 4, "title": "Test", "body": "- [ ] First\n- [ ] Second\n",
                      "state": "open", "labels": [{"name": "status:in-progress"}]}
        self.session = self.service.reserve(self.project, "developer", "Inspect", False, launch=False)
        row = self.store.session(self.session)
        with self.store.db:
            self.service.pin_issue(self.session, row["generation"], {
                "repository": "fixture/project", "issue": 4, "fingerprint": fingerprint(self.issue, [])})
            self.store.db.execute("UPDATE github_run SET phase='work' WHERE session=?", (self.session,))

    def draft(self, criterion):
        row = self.store.session(self.session)
        run = self.service.github_run(row)
        operation = self.service.save_tracker_draft(self.project, "checklist",
            {"issue": 4, "criterion": criterion, "checked": True}, "developer")
        self.service.guard_tracker(operation, row, run)
        return operation

    async def read(self, *args):
        return deepcopy(self.issue), []

    async def apply(self, repository, kind, payload, key, actor, *, before):
        self.assertEqual(before["body"], self.issue["body"])
        self.issue["body"] = checklist(self.issue["body"], payload["criterion"], payload["checked"])
        return {"number": 4}

    def human_check(self, criterion):
        return self.service.draft_tracker(self.project, "checklist",
                                          {"issue": 4, "criterion": criterion, "checked": True})

    def restart_database(self):
        home = self.store.home
        self.store.db.close()
        self.store = test_adf.Store(home)
        self.service.store = self.store
        self.store.recover()

    async def test_human_lost_response_survives_restart_and_blocks_later_write(self):
        self.pin()
        sends = []

        async def api(repository, method, endpoint, payload=None):
            if method == "GET":
                return deepcopy(self.issue)
            sends.append(payload)
            self.issue.update(payload)
            if len(sends) == 1:
                raise TimeoutError
            return deepcopy(self.issue)

        with patch("adf.tracker.gh_api", api):
            first = self.human_check("First")
            second = self.human_check("Second")
            with self.assertRaises(TimeoutError):
                await self.service.review_tracker(first, True)
            self.restart_database()
            with self.assertRaisesRegex(ValueError, "照合"):
                await self.service.review_tracker(second, True)
            await self.service.reconcile_tracker(first)
            self.assertEqual(len(sends), 1)
            await self.service.review_tracker(second, True)
        self.assertEqual(len(sends), 2)
        self.assertEqual(self.issue["body"], "- [x] First\n- [x] Second\n")

    async def test_human_unapplied_requires_explicit_resolution_and_new_approval(self):
        self.pin()
        sends = []

        async def api(repository, method, endpoint, payload=None):
            if method == "GET":
                return deepcopy(self.issue)
            sends.append(payload)
            if len(sends) == 1:
                raise TimeoutError
            self.issue.update(payload)
            return deepcopy(self.issue)

        with patch("adf.tracker.gh_api", api):
            first = self.human_check("First")
            with self.assertRaises(TimeoutError):
                await self.service.review_tracker(first, True)
            with self.assertRaises(ValueError):
                await self.service.reconcile_tracker(first)
            await self.service.reconcile_tracker(first, confirm_unapplied=True)
            replacement = self.human_check("First")
            self.assertNotEqual(first, replacement)
            self.assertEqual(self.human_check("First"), replacement)
            self.assertEqual(len(sends), 1)
            await self.service.review_tracker(replacement, True)
            self.assertEqual(self.human_check("First"), replacement)
        self.assertEqual(len(sends), 2)

    async def test_human_third_party_edit_requires_manual_reconciliation(self):
        self.pin()
        pinned = self.store.one("SELECT fingerprint FROM github_run")["fingerprint"]

        async def api(repository, method, endpoint, payload=None):
            if method == "PATCH":
                self.issue.update(payload)
                self.issue["body"] += "Third party edit\n"
            return deepcopy(self.issue)

        with patch("adf.tracker.gh_api", api):
            first = self.human_check("First")
            with self.assertRaisesRegex(ValueError, "想定"):
                await self.service.review_tracker(first, True)
            for options in ({}, {"confirm_unapplied": True}):
                with self.assertRaises(ValueError):
                    await self.service.reconcile_tracker(first, **options)
            result = await self.service.reconcile_tracker(first, accept_external_edit=True)
        self.assertTrue(result["external_edit"])
        self.assertEqual(self.store.one("SELECT fingerprint FROM github_run")["fingerprint"], pinned)

    async def test_sequential_updates_keep_issue_current(self):
        self.pin()
        with (patch.object(self.service, "load_issue", self.read), patch("adf.tracker.perform", self.apply)):
            for criterion in ("First", "Second"):
                await self.service.review_tracker(self.draft(criterion), True)
                row = self.store.session(self.session)
                await self.service.current_issue(row, self.service.github_run(row))
        self.assertEqual(self.issue["body"], "- [x] First\n- [x] Second\n")
        sends = []

        async def api(repo, method, endpoint, payload=None):
            if method == "GET":
                return deepcopy(self.issue)
            sends.append(payload)
            return dict(self.issue, **payload)

        with (patch.object(self.service, "load_issue", self.read), patch("adf.tracker.gh_api", api)):
            operation = self.service.draft_tracker(self.project, "complete", {"issue": 4})
            # A real close is allowed after both checks. This draft is explicitly
            # reviewed by the human, independently of the managed research run.
            await self.service.review_tracker(operation, True)
        self.assertEqual(sends, [{"state": "closed", "state_reason": "completed"}])

    async def test_unknown_delivery_is_reconciled_without_replay(self):
        self.pin()
        async def lost(*args, **kwargs):
            await self.apply(*args, **kwargs)
            raise TimeoutError
        with (patch.object(self.service, "load_issue", self.read), patch("adf.tracker.perform", lost)):
            operation = self.draft("First")
            with self.assertRaises(TimeoutError):
                await self.service.review_tracker(operation, True)
            with self.assertRaises(ValueError):
                await self.service.review_tracker(self.draft("Second"), True)
            await self.service.reconcile_tracker(operation)
            row = self.store.session(self.session)
            await self.service.current_issue(row, self.service.github_run(row))

    async def test_third_party_edit_never_updates_checkpoint(self):
        self.pin()
        async def changed(*args, **kwargs):
            await self.apply(*args, **kwargs)
            self.issue["body"] += "Third party\n"
            return {"number": 4}
        with (patch.object(self.service, "load_issue", self.read), patch("adf.tracker.perform", changed)):
            operation = self.draft("First")
            with self.assertRaisesRegex(ValueError, "想定"):
                await self.service.review_tracker(operation, True)
            with self.assertRaises(ValueError):
                await self.service.reconcile_tracker(operation)
        self.assertEqual(self.store.one("SELECT state FROM tracker_operation WHERE id=?", (operation,))["state"], "sending")

    async def test_stop_during_send_retains_record_without_restarting(self):
        self.pin()
        started, finish = asyncio.Event(), asyncio.Event()
        async def delayed(*args, **kwargs):
            started.set()
            await finish.wait()
            return await self.apply(*args, **kwargs)
        with (patch.object(self.service, "load_issue", self.read), patch("adf.tracker.perform", delayed)):
            op = self.draft("First")
            pending = asyncio.create_task(self.service.review_tracker(op, True))
            await started.wait()
            await self.service.stop_role(self.project, "developer", immediate=True)
            finish.set()
            await pending
        row = self.store.session(self.session)
        self.assertEqual((row["state"], row["turn_requests"]), ("paused", 0))
        self.assertEqual(self.store.one("SELECT fingerprint FROM github_run")["fingerprint"], fingerprint(self.issue, []))

    async def test_partial_progress_requires_read_only_reconciliation_after_repair(self):
        self.pin()
        self.service.set_tracker_policy(self.project, {"progress": "allow"})
        operation = self.service.draft_tracker(self.project, "progress",
            {"issue": 4, "status": "validating", "priority": ""})

        async def partial(*args):
            self.issue["labels"].append({"name": "status:validating"})
            raise TimeoutError
        with patch("adf.tracker.perform", partial):
            with self.assertRaises(TimeoutError):
                await self.service.review_tracker(operation, True)
        self.store.recover()
        with patch("adf.tracker.fetch_issue", AsyncMock(return_value=self.issue)):
            with self.assertRaises(ValueError):
                await self.service.reconcile_tracker(operation)
            self.issue["labels"] = [{"name": "status:validating"}]
            self.assertTrue((await self.service.reconcile_tracker(operation))["reconciled"])
        self.assertEqual(self.store.one("SELECT state FROM tracker_operation WHERE id=?", (operation,))["state"],
                         "confirmed")
