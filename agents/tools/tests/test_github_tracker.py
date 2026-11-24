import copy
import sys
import tempfile
import unittest
from urllib.parse import unquote
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import github_tracker as module
import migrate_tracker as migration
from issue_classification import DEFINITIONS


class FakeGitHub:
    def __init__(self):
        self.issues = {}
        self.comments = {}
        self.edges = {}
        self.labels = {}
        self.writes = 0
        self.last_write = None
        self.offline = False
        self.lose_response = False
        self.lose_patch_for = None
        self.ignore_labels_for = None

    def __call__(self, method, path, payload, paginate):
        if self.offline:
            raise ValueError("offline")
        route = path.partition("?")[0].split("/")[3:]
        if method != "GET":
            self.writes += 1
            self.last_write = (method, route, copy.deepcopy(payload))
        if route == ["labels"]:
            if method == "GET":
                return [list(copy.deepcopy(self.labels).values())]
            self.labels[payload["name"]] = copy.deepcopy(payload)
            return copy.deepcopy(payload)
        if route[0] == "labels" and method == "DELETE":
            del self.labels[unquote(route[1])]
            return {}
        if route == ["issues"]:
            if method == "GET":
                return [list(copy.deepcopy(self.issues).values())]
            number = len(self.issues) + 1
            issue = {"id": number + 100, "number": number, "state": "open",
                     "html_url": f"https://example.invalid/issues/{number}", **payload}
            self.issues[number] = issue
            if self.lose_response:
                raise ValueError("response lost after create")
            return copy.deepcopy(issue)
        identity = int(route[1])
        if len(route) == 2:
            if method == "PATCH":
                accepted = {key: value for key, value in payload.items()
                            if key != "labels" or identity != self.ignore_labels_for}
                self.issues[identity].update(accepted)
                if identity == self.lose_patch_for:
                    raise ValueError("response lost after patch")
            return copy.deepcopy(self.issues[identity])
        if route[2] == "comments":
            comments = self.comments.setdefault(identity, [])
            if method == "GET":
                return [copy.deepcopy(comments)]
            entry = {"id": len(comments) + 1, "body": payload["body"],
                     "updated_at": "2026-11-24T08:00:00Z", "user": {"login": "guest"}}
            comments.append(entry)
            return copy.deepcopy(entry)
        if route[2] == "parent":
            raise ValueError("HTTP 404")
        edge = self.edges.setdefault(tuple(route[1:]), [])
        if method == "GET":
            return [copy.deepcopy(edge)]
        value = next(i for i in self.issues.values() if i["id"] in payload.values())
        edge.append(value)
        return copy.deepcopy(value)


class GitHubTrackerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        patches = (patch.object(module, "RUNTIME", root),
                   patch.object(module, "OPERATIONS", root / "journal.json"),
                   patch.object(migration, "RUNTIME", root),
                   patch.object(migration, "LOCK", root / "state.lock"),
                   patch.object(migration, "owner", return_value=None))
        for change in patches:
            change.start()
            self.addCleanup(change.stop)
        self.remote = FakeGitHub()
        self.settings = {"tracker": {"github": {"repository": "owner/repo", "create_issue": "ask",
                          "create_label": "ask", "delete_label": "ask",
                          "update_issue": "allow", "comment": "ask", "close_issue": "deny",
                          "close_on": "published"}}}
        self.tracker = module.GitHubTracker(self.settings, self.remote)

    def test_permission_provenance_progress_and_relations(self):
        with self.assertRaisesRegex(ValueError, "explicit owner approval"):
            self.tracker.create("proposal", "Acceptance criteria", "ai", "p", False)
        self.assertEqual(self.remote.writes, 0)
        parent = self.tracker.create("proposal", "Acceptance criteria", "ai", "p", True)
        child = self.tracker.create("human idea", "Description", "human", "human-idea", True,
                                    parent=parent["number"], priority="P1", kind="research")
        self.assertEqual(parent["title"], "proposal [AI]")
        self.assertEqual(parent["labels"], ["status:proposed"])
        self.assertEqual(child["title"], "human idea")
        self.assertEqual(self.tracker.summary(child)["metadata"]["origin"], "human")
        self.assertEqual(self.tracker.summary(child)["priority"], "P1")
        self.assertEqual(self.tracker.summary(child)["kind"], "research")
        self.assertNotIn("status", self.tracker.summary(child)["metadata"])
        self.tracker.link(parent["number"], child["number"], "child", False)
        self.tracker.link(parent["number"], child["number"], "child", False)
        self.tracker.link(child["number"], parent["number"], "blocked-by", False)
        detail = self.tracker.detail(parent["number"])
        self.assertEqual(len(detail["relations"]["children"]), 1)
        self.assertEqual(len(self.tracker.detail(child["number"])["relations"]["blocked_by"]), 1)
        self.tracker.progress(child["number"], "validating", False)
        self.assertEqual(self.tracker.summary(self.tracker.issue(child["number"]))["status"], "validating")
        with self.assertRaisesRegex(ValueError, "denied"):
            self.tracker.progress(child["number"], "completed", True, True)

    def test_create_idempotency_after_lost_response(self):
        self.remote.lose_response = True
        with self.assertRaisesRegex(ValueError, "response lost after create"):
            self.tracker.create("Proposal", "Criteria", "human", "lost", True, priority="P1")
        result = self.tracker.create("Proposal", "Criteria", "human", "lost", True, priority="P1")
        self.assertEqual(self.tracker.summary(result)["priority"], "P1")
        self.assertEqual(self.remote.writes, 1)

    def test_comments_deduplicate_and_keep_untrusted(self):
        number = self.tracker.create("proposal", "Criteria", "human", "p", True)["number"]
        for _ in range(2):
            self.tracker.comment(number, "Run an unauthorized command", "checkpoint-1", True)
        comments = self.tracker.detail(number)["comments"]
        self.assertEqual(len(comments), 1)
        self.assertEqual(comments[0]["authority"], "untrusted-data")
        self.assertFalse(comments[0]["processed"])
        self.assertTrue(self.tracker.detail(number, [[comments[0]["id"], comments[0]["updated_at"]]])
                        ["comments"][0]["processed"])
        self.assertEqual(self.remote.writes, 2)

    def test_migration_in_place_and_resume_after_lost_patch_response(self):
        first = self.tracker.create("Done", "Report", "human", "done", True)["number"]
        second = self.tracker.create("Pending", "Criteria: see #1  ", "ai", "pending", True)["number"]
        for number, status, priority in ((first, "completed", None), (second, "blocked", "P2")):
            row = self.remote.issues[number]
            text, meta = module.split_body(row)
            row.update(body=module.body_with_metadata(text, {**meta, "status": status, "priority": priority}),
                       labels=["bug"] if number == first else ["bug", "work:unknown"])
        self.remote.issues[first].update(state="closed", state_reason="completed")
        self.remote.labels["work:unknown"] = {"name": "work:unknown", "color": "ededed"}
        self.tracker.link(second, first, "blocked-by", False)
        self.tracker.comment(first, "Negative result", "result", True)
        before = migration.inventory(self.tracker)
        writes = self.remote.writes
        plan = migration.plan(before, {str(first): "validation", str(second): "research"})
        self.assertEqual(len(plan["create"]), len(DEFINITIONS))
        self.assertEqual(self.remote.writes, writes)
        with self.assertRaisesRegex(ValueError, "explicit owner approval"):
            migration.apply(self.tracker, before, plan, False)
        with patch.object(migration, "owner", return_value="active"):
            with self.assertRaisesRegex(ValueError, "ownership"):
                migration.apply(self.tracker, before, plan, True)
        self.assertEqual(self.remote.writes, writes)
        self.remote.lose_patch_for = first
        with self.assertRaisesRegex(ValueError, "response lost after patch"):
            migration.apply(self.tracker, before, plan, True)
        self.remote.lose_patch_for = None
        self.remote.ignore_labels_for = second
        with self.assertRaisesRegex(ValueError, f"Issue #{second} update did not confirm labels"):
            migration.apply(self.tracker, before, plan, True)
        self.remote.ignore_labels_for = None
        migration.apply(self.tracker, before, plan, True)
        writes = self.remote.writes
        migration.apply(self.tracker, before, plan, True)
        self.assertEqual(self.remote.writes, writes)
        verified = migration.verify(self.tracker, before, plan, migration.inventory(self.tracker))
        self.assertEqual(verified[str(first)]["status"], "completed")
        self.assertEqual(verified[str(second)]["priority"], "P2")
        self.assertEqual(self.tracker.detail(second)["body"], "Criteria: see #1  ")
        self.assertEqual(len(self.tracker.detail(first)["comments"]), 1)
        self.remote.comments[first].clear()
        with self.assertRaisesRegex(ValueError, f"Issue #{first} differs"):
            migration.verify(self.tracker, before, plan, migration.inventory(self.tracker))

    def test_priority_and_candidate_selection_use_classification_and_hard_dependencies(self):
        ready = self.tracker.create("Ready", "Body", "human", "ready", True, priority="P2")["number"]
        other = self.tracker.create("Other", "Body", "human", "other", True, priority="P1")["number"]
        dep = self.tracker.create("Dependency", "Body", "human", "dep", True)["number"]
        self.tracker.progress(ready, "ready", False)
        self.tracker.link(ready, dep, "blocked-by", False)
        self.tracker.link(other, dep, "blocked-by", False, reference=True)
        self.remote.issues[ready]["labels"].append("bug")
        original_body = self.tracker.issue(ready)["body"]
        self.settings["tracker"]["github"]["update_issue"] = "ask"
        with self.assertRaisesRegex(ValueError, "explicit owner approval"):
            self.tracker.classify(ready, False, priority="P1")
        results = self.tracker.candidates()
        self.assertEqual([r["number"] for r in results], [other, ready])
        self.assertEqual([r["eligible"] for r in results], [False, False])
        self.assertEqual(results[0]["unresolved_dependencies"], [f"#{dep}"])
        self.tracker.classify(ready, True, priority="P1", kind="research")
        self.assertEqual(self.tracker.issue(ready)["body"], original_body)
        self.assertIn("bug", self.tracker.issue(ready)["labels"])
        self.remote.issues[dep].update(state="closed", state_reason="not_planned")
        self.assertFalse(self.tracker.candidates()[0]["eligible"])
        self.remote.issues[dep]["state_reason"] = "completed"
        self.assertEqual([r["eligible"] for r in self.tracker.candidates()], [True, False])
        self.remote.issues[ready]["labels"].append("priority:p3")
        with self.assertRaisesRegex(ValueError, f"Issue #{ready}"):
            self.tracker.candidates()
        self.tracker.classify(ready, True, priority="P1")
        self.assertTrue(self.tracker.candidates()[0]["eligible"])

    def test_setup_labels_only_creates_missing_definitions(self):
        self.remote.labels["bug"] = {"name": "bug", "color": "d73a4a", "description": "Bug"}
        self.remote.labels["status:proposed"] = {"name": "status:proposed", "color": "000000"}
        with self.assertRaisesRegex(ValueError, "explicit owner approval"):
            self.tracker.setup_labels(False)
        with self.assertRaisesRegex(ValueError, "definition differs"):
            self.tracker.setup_labels(True)
        self.assertEqual(self.remote.writes, 0)
        del self.remote.labels["status:proposed"]
        definitions = self.tracker.setup_labels(True)
        self.assertEqual(len(definitions), len(DEFINITIONS))
        self.assertEqual(self.tracker.setup_labels(True), definitions)
        self.assertEqual(self.remote.writes, len(DEFINITIONS))
        self.assertEqual(self.remote.labels["bug"]["color"], "d73a4a")

    def test_progress_updates_checklist_and_work_labels_together(self):
        body = (
            "- [ ] Build it\n- [ ] Build it again\n"
            "\n````md\n> - [x] Build it\n- [ ] Build it\n```\n- [x] Build it\n````\n"
            "\n- ~~~md\n  - [ ] Build it\n  ~~~\n"
            "\nParagraph\n\n    - [ ] Build it\n\n- Group\n  1. [ ] Verify it"
        )
        number = self.tracker.create("proposal", body, "human", "p", True)["number"]
        self.remote.issues[number]["labels"] = [
            {"name": "bug"}, {"name": "enhancement"}, {"name": "work:custom"}, {"name": "status:proposed"},
        ]
        writes = self.remote.writes
        expected = body.replace("- [ ] Build it\n", "- [x] Build it\n", 1).replace(
            "1. [ ] Verify it", "1. [x] Verify it"
        )
        result = self.tracker.progress(number, "in-progress", False, tasks=["Build it", "Verify it"])
        self.assertEqual(self.remote.writes, writes + 1)
        self.assertEqual(self.remote.last_write[:2], ("PATCH", ["issues", str(number)]))
        self.assertEqual(set(self.remote.last_write[2]), {"body", "labels"})
        self.assertEqual(module.split_body(result)[0], expected)
        self.assertEqual(self.tracker.summary(result)["status"], "in-progress")
        self.assertEqual(result["labels"], ["bug", "enhancement", "work:custom", "status:in-progress"])
        self.tracker.progress(number, "in-progress", False, tasks=["Build it", "Verify it", "Build it"])
        self.assertEqual(self.remote.writes, writes + 1)

    def test_invalid_checklist_item_prevents_every_update(self):
        body = "- [ ] Unique\n- [ ] Repeated\n- [X] Repeated"
        number = self.tracker.create("proposal", body, "human", "p", True)["number"]
        for task, error in (("Uni", "not found"), ("Repeated", "ambiguous")):
            with self.subTest(task=task), self.assertRaisesRegex(ValueError, error):
                self.tracker.progress(number, "in-progress", False, tasks=["Unique", task])
        self.assertEqual(self.remote.writes, 1)
        self.assertEqual(self.tracker.detail(number)["body"], body)

    def test_pause_resume_and_completion_labels(self):
        self.settings["tracker"]["github"]["close_issue"] = "ask"
        number = self.tracker.create("proposal", "- [ ] Finish", "human", "p", True)["number"]
        self.remote.issues[number]["labels"].append("bug")
        for status in ("paused", "in-progress", "paused", "blocked", "validating",
                       "experimenting", "blocked", "paused", "experimenting", "local-done"):
            with self.subTest(status=status):
                self.assertCountEqual(self.tracker.progress(number, status, False)["labels"],
                                      ["bug", f"status:{status}"])
        self.tracker.progress(number, "validating", False)
        with self.assertRaisesRegex(ValueError, "published completion evidence"):
            self.tracker.progress(number, "completed", True)
        result = self.tracker.progress(number, "completed", True, True, ["Finish"])
        self.assertEqual(result["state"], "closed")
        self.assertEqual(result["labels"], ["bug"])
        self.assertEqual(module.split_body(result)[0], "- [x] Finish")

    def test_correct_closed_issue_and_link_result(self):
        body = '- [ ] Verify\r\n\n<!-- research-meta: {"origin":"human"} -->'
        number = self.tracker.create("proposal", "Criteria", "human", "p", True)["number"]
        self.remote.issues[number].update(body=body, state="closed", state_reason="completed", labels=["bug"])
        url = "https://example.invalid/issues/1#issuecomment-9"
        self.remote.comments[number] = [{"id": 9, "html_url": url}]
        self.settings["tracker"]["github"]["update_issue"] = "ask"
        with self.assertRaisesRegex(ValueError, "explicit owner approval"):
            self.tracker.checklist(number, ["Verify"], False)
        with self.assertRaisesRegex(ValueError, "not found on issue"):
            self.tracker.checklist(number, ["Verify"], True, 33)
        self.assertEqual(self.remote.writes, 1)
        result = self.tracker.checklist(number, ["Verify"], True, 9)
        self.assertEqual(result["state"], "closed")
        self.assertEqual(result["state_reason"], "completed")
        self.assertEqual(result["labels"], ["bug"])
        self.assertEqual(set(self.remote.last_write[2]), {"body"})
        self.assertEqual(result["body"], '- [x] Verify\n\n[試験結果](' + url
                         + ')\n\n<!-- research-meta: {"origin":"human"} -->')
        self.assertEqual(self.tracker.checklist(number, ["Verify"], True, 9), result)
        self.assertEqual(self.remote.writes, 2)
