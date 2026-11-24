import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import github_tracker as module


class FakeGitHub:
    def __init__(self):
        self.issues = {}
        self.comments = {}
        self.edges = {}
        self.writes = 0
        self.offline = False
        self.lose_response = False

    def __call__(self, method, path, payload, paginate):
        if self.offline:
            raise ValueError("offline")
        route = path.partition("?")[0].split("/")[3:]
        if method != "GET":
            self.writes += 1
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
                self.issues[identity].update(payload)
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
            raise ValueError("no parent")
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
                   patch.object(module, "OPERATIONS", root / "journal.json"))
        for change in patches:
            change.start()
            self.addCleanup(change.stop)
        self.remote = FakeGitHub()
        self.settings = {"tracker": {"github": {"repository": "owner/repo", "create_issue": "ask",
                          "update_issue": "allow", "comment": "ask", "close_issue": "deny",
                          "close_on": "published"}}}
        self.tracker = module.GitHubTracker(self.settings, self.remote)

    def test_permission_provenance_progress_and_relations(self):
        with self.assertRaisesRegex(ValueError, "explicit owner approval"):
            self.tracker.create("proposal", "Acceptance criteria", "ai", "p", False)
        self.assertEqual(self.remote.writes, 0)
        parent = self.tracker.create("proposal", "Acceptance criteria", "ai", "p", True)
        child = self.tracker.create("human idea", "Description", "human", "human-idea", True,
                                    parent=parent["number"], priority="high")
        self.assertEqual(parent["title"], "proposal [AI]")
        self.assertEqual(child["title"], "human idea")
        self.assertEqual(self.tracker.summary(child)["metadata"]["origin"], "human")
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

    def test_migration_dry_run_retry_and_offline(self):
        state = {"tasks": {"R-001": {"title": "Done", "next": "report.md", "origin": "ai", "status": "done"},
                           "R-002": {"title": "Later", "next": "Verify", "origin": "human",
                                     "parent": "R-001", "status": "ready"}}, "reviews": {}}
        entries = module.migration_entries(state, {})
        self.assertEqual(self.tracker.migration(entries), entries)
        self.assertEqual(self.remote.writes, 0)
        self.remote.lose_response = True
        with self.assertRaisesRegex(ValueError, "response lost"):
            self.tracker.migration(entries, apply=True, approved=True)
        self.remote.lose_response = False
        numbers = self.tracker.migration(entries, apply=True, approved=True)
        self.assertEqual(self.tracker.migration(entries, apply=True, approved=True), numbers)
        self.assertEqual(len(self.remote.issues), 2)
        done = self.tracker.summary(self.tracker.issue(numbers["R-001"]))
        self.assertEqual(done["status"], "completed")
        self.assertIn("report.md", self.tracker.detail(numbers["R-001"])["body"])
        self.remote.offline = True
        with self.assertRaisesRegex(ValueError, "offline"):
            self.tracker.issues()
        self.assertEqual(self.tracker.migration(entries), entries)
