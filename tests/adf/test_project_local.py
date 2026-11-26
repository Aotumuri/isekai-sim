"""Public project-local interfaces and paused offline transfer."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from adf.ipc import EPOCH, write
from adf.local import bind_project, home_for, read_config, running, setup
from adf.maintenance import migrate
from adf.projects import identify
from adf.service import Service
from adf.store import Store, owner_lock, private_dir
import test_adf

SOURCE = Path(__file__).resolve().parents[2]


def project_fixture(root, *, full=False):
    test_adf.repo(root)
    checkout = root.resolve()
    if full:
        shutil.copytree(SOURCE / "adf", checkout / "adf",
                        ignore=shutil.ignore_patterns("__pycache__", "runtime", "macos", "review"))
        launcher = checkout / "adf/__main__.py"
        launcher.write_text(launcher.read_text().replace("from .service import runtime_path",
                                                         f"\ndef runtime_path():\n    return {test_adf.FAKE!r}\n"))
    else:
        (checkout / "adf").mkdir()
    (checkout / "adf/config.example.toml").write_text(
        '[project]\nname = "Fixture"\ngithub = "example/research"\nmission = "Verify fixtures"\n'
        '[research]\nmode = "controlled"\ntokens = 80000\n')
    return checkout


def cli(root, *args):
    result = subprocess.run([sys.executable, "-m", "adf", *args], cwd=root,
                            check=True, capture_output=True, text=True, timeout=25)
    return json.loads(result.stdout)


class ProjectLifecycle(unittest.TestCase):
    def test_project_isolation_and_crash_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            first, second = [project_fixture(Path(tmp) / name, full=True) for name in ("one", "two")]
            for root in (first, second):
                self.assertFalse(cli(root, "doctor")["core_running"])
                self.assertFalse(cli(root, "status")["running"])
                self.assertFalse(home_for(root).exists())
                cli(root, "init")
            try:
                one, two = (cli(root, "start") for root in (first, second))
                self.assertNotEqual(one["pid"], two["pid"])
                cli(first, "send", "coordinator", "hold")
                cli(second, "send", "coordinator", "second")
                cli(first, "send", "developer", "local developer")
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    state = cli(first, "skill", "developer")["state"]
                    if (len(state["sessions"]) == 2 and state["sessions"][0]["turn"]
                            and state["sessions"][1]["state"] == "idle"):
                        break
                else:
                    self.fail(f"Fixture roles did not become ready: {state}")
                self.assertEqual(cli(second, "status")["projects"][0]["path"], str(second))
                self.assertEqual([row["role"] for row in cli(second, "status")["sessions"]], ["coordinator"])
                original_thread = state["sessions"][0]["thread"]
                box = home_for(first) / "ipc"
                epoch = json.loads((box / EPOCH).read_text())["id"]
                os.kill(one["pid"], signal.SIGKILL)
                deadline = time.monotonic() + 8
                while running(home_for(first)) and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertFalse(cli(first, "status")["running"])
                stale = box / f"{uuid.uuid4().hex}.request"
                write(stale, {"action": "send", "args": {"role": "coordinator", "text": "stale"},
                              "deadline": time.time() + 20, "epoch": epoch})
                cli(first, "start")
                response = json.loads(stale.with_suffix(".response").read_text())
                self.assertIn("再起動", response["error"])
                recovered = cli(first, "status")["sessions"][0]
                self.assertEqual((recovered["state"], recovered["thread"], recovered["turn_requests"]),
                                 ("interrupted", original_thread, 1))
                self.assertEqual(cli(second, "start")["pid"], two["pid"])
                cli(first, "stop", "--immediate")
                while running(home_for(first)) and time.monotonic() < deadline + 8:
                    time.sleep(.1)
                saved = cli(first, "update")
                self.assertTrue((Path(saved["backup"]) / "state.sqlite3").is_file())
                cli(first, "start")
                self.assertEqual(cli(first, "status")["sessions"][0]["thread"], original_thread)
            finally:
                for root in (first, second):
                    cli(root, "stop", "--immediate")
                    deadline = time.monotonic() + 8
                    while running(home_for(root)) and time.monotonic() < deadline:
                        time.sleep(.1)

    def test_backup_legacy_and_select_desktop_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            root = project_fixture(temp / "fixture")
            home = private_dir(home_for(root))
            source = private_dir(temp / "desktop")
            old = Store(source)
            _, identity = asyncio.run(identify(root))
            try:
                with owner_lock(source):
                    with old.db:
                        old.db.execute("INSERT INTO project VALUES (7,'other','/not/this','other','',0)")
                        old.db.execute("INSERT INTO project VALUES (9,'ours',?,?,'example/research',0)",
                                       (str(root), identity))
                        old.db.execute("INSERT INTO session(id,project,role,thread,prompt) VALUES "
                                       "(5,9,'developer','saved-thread','saved checkpoint')")
                        old.db.execute("INSERT INTO session(id,project,role,thread) VALUES "
                                       "(6,7,'developer','other-thread')")
                        old.db.execute("INSERT INTO job(id,session,generation,call,turn,revision,name,state,started,"
                                       "initial_requests,initial_tokens) VALUES "
                                       "('our-job',5,0,'call','turn','rev','fixture','succeeded',1,1,17)")
                    log = source / "jobs/our-job/output.log"
                    log.parent.mkdir(parents=True)
                    log.write_text("evidence")
                    report = migrate(root, home, "desktop", source, None)
                    self.assertTrue(report["source_running"])
                    with self.assertRaises(BlockingIOError):
                        migrate(root, home, "desktop", source, report["fingerprint"])
                report = migrate(root, home, "desktop", source, None)
                self.assertEqual(report["sessions"][0]["thread"], "saved-thread")
                with patch("adf.maintenance.finish_desktop_transfer", side_effect=OSError("fixture crash")):
                    with self.assertRaisesRegex(OSError, "fixture crash"):
                        migrate(root, home, "desktop", source, report["fingerprint"])
                self.assertTrue(migrate(root, home, "desktop", source, None)["destination_pending"])
                completed = migrate(root, home, "desktop", source, report["fingerprint"])
                self.assertTrue(Path(completed["archive"], "desktop-backup.sqlite3").exists())
                self.assertEqual(old.one("SELECT count(*) AS n FROM project")["n"], 2)
                self.assertTrue(migrate(root, home, "desktop", source, report["fingerprint"])["already_imported"])
                self.assertEqual((home / "jobs/our-job/output.log").read_text(), "evidence")
                setup(root)
                local = Store(home)
                try:
                    service = Service(local, test_adf.FAKE)
                    asyncio.run(bind_project(service, root, read_config(home / "config.toml")))
                    self.assertEqual([row["id"] for row in local.all("SELECT id FROM project")], [9])
                    self.assertEqual(local.session(5)["prompt"], "saved checkpoint")
                    self.assertIsNone(local.session(6))
                finally:
                    local.db.close()
                legacy = root / "agents/runtime"
                legacy.mkdir(parents=True)
                (legacy / "github-checkpoint.json").write_text('{"next":"verify prior"}')
                (legacy / "developer.json").write_text('{"id":"legacy-owner"}')
                blocked = migrate(root, home, "legacy", None, None)
                self.assertTrue(blocked["conflicts"])
                (legacy / "developer.json").unlink()
                report = migrate(root, home, "legacy", None, None)
                self.assertEqual(report["checkpoint"]["next"], "verify prior")
                answer = migrate(root, home, "legacy", None, report["fingerprint"])
                self.assertTrue(Path(answer["archive"], "legacy-runtime/github-checkpoint.json").is_file())
                self.assertTrue((legacy / "github-checkpoint.json").is_file())
            finally:
                old.db.close()


class DiscoveryTest(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_adf.OrchestratorTest.asyncSetUp
    asyncTearDown = test_adf.OrchestratorTest.asyncTearDown
    state = test_adf.OrchestratorTest.state
    wait = test_adf.OrchestratorTest.wait

    async def test_discovery_drafts_once_and_stop_revokes_approval(self):
        config = {"name": "Fixture", "github": "example/research", "mission": "Bounded evidence",
                  "preset": {"name": "controlled"}}
        await bind_project(self.service, self.path.resolve(), config)
        self.service.set_tracker_policy(self.project, {"proposal": "allow"})
        with (patch.object(self.service, "list_issues", AsyncMock(return_value=[])),
              patch("adf.tracker.perform", AsyncMock()) as send):
            await self.service.dispatch("research-start", {"tasks": [], "scope": "Look for a fixture hypothesis",
                                        "preset": "research-autonomous", "tokens": 50000})
            row = await self.state("developer", "paused")
            result = self.service.status(self.project)
            self.assertEqual((row["turn_requests"], len(result["tracker_operations"])), (1, 1))
            draft = result["tracker_operations"][0]
            self.assertEqual((draft["kind"], draft["state"]), ("proposal", "pending"))
            self.assertEqual(result["github_runs"], [])
            await self.service.stop_role(self.project, "developer")
            self.assertEqual(self.service.status(self.project)["tracker_operations"][0]["state"], "expired")
            send.assert_not_awaited()


    async def test_discovery_can_submit_under_policy_without_starting_issue(self):
        config = {"name": "Fixture", "github": "example/research", "mission": "Bounded evidence",
                  "preset": {"name": "controlled"}}
        await bind_project(self.service, self.path.resolve(), config)
        self.service.set_tracker_policy(self.project, {"proposal": "allow"})
        with (patch.object(self.service, "list_issues", AsyncMock(return_value=[])),
              patch("adf.tracker.perform", AsyncMock(return_value={"number": 8})) as send):
            await self.service.dispatch("research-start", {"tasks": [], "scope": "Explore",
                                        "preset": "research-autonomous", "tokens": 50000,
                                        "discovery_issue": "policy"})
            row = await self.state("developer", "paused")
            result = self.service.status(self.project)
            self.assertEqual((row["turn_requests"], result["github_runs"]), (1, []))
            self.assertEqual(result["tracker_operations"][0]["state"], "confirmed")
            send.assert_awaited_once()

    async def test_existing_issue_requires_explicit_scope_after_mission_change(self):
        config = {"name": "Fixture", "github": "example/research", "mission": "Prior mission",
                  "preset": {"name": "controlled", "tokens": 50000, "recovery": "manual"}}
        await bind_project(self.service, self.path.resolve(), config)
        self.service.set_tracker_policy(self.project, {"progress": "ask"})
        issue = {"id": 5, "number": 5, "title": "Prior issue", "body": "", "state": "open",
                 "labels": [{"name": "status:ready"}]}
        with patch.object(self.service, "load_issue", AsyncMock(return_value=(issue, []))):
            await self.service.dispatch("research-start", {"tasks": [5], "scope": "Previous scope"})
            await self.state("developer", "paused")
            await self.service.stop_role(self.project, "developer")
            self.service.local_config["mission"] = "Updated mission"
            with self.assertRaisesRegex(ValueError, "--scope"):
                await self.service.dispatch("research-resume", {})
            await self.service.dispatch("research-resume", {"scope": "Reapproved existing work"})
            row = await self.state("developer", "paused")
            result = self.service.status(self.project)
            self.assertEqual(row["turn_requests"], 0)
            self.assertEqual(result["github_runs"][0]["issue"], 5)
            approved = json.loads(result["research_runs"][0]["scope"])
            self.assertEqual(approved["mission"], "Updated mission")
            self.assertIn("Reapproved existing work", approved["instructions"])
