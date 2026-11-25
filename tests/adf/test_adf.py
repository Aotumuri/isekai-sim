import asyncio
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import time
import uuid
from unittest.mock import patch

from adf.ipc import Client, receive, write
from adf.service import Service
from adf.store import Store, private_dir

FAKE = str(Path(__file__).with_name("fake_codex.py").resolve())


def repo(path):
    path.mkdir()
    (path / "fixture.txt").write_text("committed data\n")
    commands = [
        ("init", "-q"),
        ("add", "fixture.txt"),
        ("-c", "user.name=ADF Test", "-c", "user.email=test@example.invalid",
         "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"),
    ]
    for args in commands:
        subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(path), *args],
                       check=True, capture_output=True)


class OrchestratorTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.path = root / "project"
        repo(self.path)
        self.store = Store(private_dir(root / "state"))
        self.service = Service(self.store, FAKE)
        self.project = (await self.service.register(self.path))["id"]

    async def asyncTearDown(self):
        await self.service.close()
        self.store.db.close()

    async def wait(self, predicate, timeout=8):
        async with asyncio.timeout(timeout):
            while not (result := predicate()):
                await asyncio.sleep(0.02)
        return result

    async def state(self, role, *states):
        def find():
            row = self.service.session_for(self.project, role)
            return row if row and row["state"] in states else None
        return await self.wait(find)

    def jobs(self):
        return self.service.status(self.project)["jobs"]

    async def start_experiment(self, duration="0.55"):
        self.service.set_template(self.project, "trial", ["/bin/sleep", duration], 10)
        await self.service.message(self.project, "developer", "launch experiment", experiment="trial")
        return await self.state("developer", "waiting")

    async def test_experiment_wait_has_no_turn_requests_or_token_change_and_wakes_once(self):
        (self.path / "fixture.txt").write_text("working copy only\n")
        waiting = await self.start_experiment()
        self.assertIsNone(waiting["turn"])
        self.assertEqual(waiting["turn_requests"], 1)
        await asyncio.sleep(0.15)
        self.assertEqual(self.service.session_for(self.project, "developer")["turn_requests"], 1)
        complete = await self.state("developer", "idle")
        self.assertEqual(complete["turn_requests"], 2)
        self.assertEqual(complete["thread"], waiting["thread"])
        job, = self.jobs()
        self.assertGreater(job["finished"], job["waiting_since"])
        self.assertEqual(job["waiting_requests"] - job["initial_requests"], 0)
        self.assertEqual(job["waiting_tokens"] - job["initial_tokens"], 0)
        self.assertEqual(job["state"], "succeeded")
        self.assertEqual(job["wake"], "claimed")
        self.assertIn("EXPERIMENT_COMPLETED", self.service.read_log(job["id"]))
        snapshot = self.service.log_path(job["id"]).parent / "source/fixture.txt"
        self.assertEqual(snapshot.read_text(), "committed data\n")
        self.assertEqual(sum(event["kind"] == "wake" for event in self.service.status(self.project)["events"]), 1)

    async def test_unapproved_model_tool_call_cannot_start_execution(self):
        self.service.set_template(self.project, "trial", ["/bin/sleep", "0.1"], 10)
        await self.service.message(self.project, "developer", "launch experiment")
        await self.state("developer", "idle")
        self.assertEqual(self.jobs(), [])

    async def test_graceful_stop_suppresses_wake_then_resume_retains_thread(self):
        waiting = await self.start_experiment()
        await self.service.stop_role(self.project, "developer")
        self.assertEqual(self.service.session_for(self.project, "developer")["state"], "draining")
        paused = await self.state("developer", "paused")
        self.assertEqual(paused["turn_requests"], 1)
        self.assertEqual(self.jobs()[0]["wake"], "suppressed")
        self.assertEqual(self.jobs()[0]["state"], "succeeded")
        await self.service.resume_role(self.project, "developer", "Read result")
        idle = await self.state("developer", "idle")
        self.assertEqual(idle["thread"], waiting["thread"])
        self.assertEqual(idle["turn_requests"], 2)

    async def test_immediate_stop_terminates_a_managed_experiment(self):
        await self.start_experiment("20")
        await self.wait(lambda: self.service.executing)
        await self.service.stop_role(self.project, "developer", immediate=True)
        await self.state("developer", "paused")
        self.assertEqual(self.jobs()[0]["state"], "cancelled")
        self.assertEqual(self.jobs()[0]["wake"], "suppressed")

    async def test_role_ownership_and_midturn_steering(self):
        self.service.set_role("coordinator", "Research constraints", "test-model", "low")
        await self.service.message(self.project, "coordinator", "hold")
        await self.service.message(self.project, "developer", "hold")
        other = self.path.parent / "other"
        repo(other)
        other_id = (await self.service.register(other))["id"]
        with self.assertRaisesRegex(ValueError, "同じロール"):
            await self.service.message(other_id, "coordinator", "duplicate")
        coordinator = await self.wait(lambda: (row := self.service.session_for(self.project, "coordinator"))["turn"] and row)
        developer = await self.wait(lambda: (row := self.service.session_for(self.project, "developer"))["turn"] and row)
        self.assertNotEqual(coordinator["thread"], developer["thread"])
        await self.service.message(self.project, "coordinator", "steer")
        await self.service.stop_role(self.project, "coordinator", immediate=True)
        await self.state("coordinator", "paused")
        self.assertEqual(self.service.settings("coordinator")["instructions"], "Research constraints")
        self.assertEqual(self.service.session_for(self.project, "developer")["state"], "running")

    async def test_recovery_retains_thread_without_automatic_replay(self):
        waiting = await self.start_experiment("20")
        await self.service.close()
        self.store.recover()
        self.service = Service(self.store, FAKE)
        row = await self.state("developer", "interrupted")
        self.assertEqual(row["thread"], waiting["thread"])
        self.assertEqual(row["turn_requests"], 1)
        self.assertEqual(self.jobs()[0]["wake"], "suppressed")
        await self.service.resume_role(self.project, "developer", "Review interruption")
        row = await self.state("developer", "idle")
        self.assertEqual(row["thread"], waiting["thread"])

    async def test_quota_pauses_without_retries_or_known_reset(self):
        self.service.set_role("developer", recovery="confirmed")
        await self.service.message(self.project, "developer", "quota")
        await self.state("developer", "quota")
        await asyncio.sleep(0.2)
        self.assertEqual(self.service.session_for(self.project, "developer")["turn_requests"], 1)

    async def test_send_to_paused_and_interrupted_sessions(self):
        await self.service.message(self.project, "developer", "first")
        first = await self.state("developer", "idle")
        await self.service.stop_role(self.project, "developer")
        await self.state("developer", "paused")
        await self.service.message(self.project, "developer", "after pause")
        await self.state("developer", "idle")
        self.store.recover()
        await self.state("developer", "interrupted")
        await self.service.message(self.project, "developer", "after interruption")
        final = await self.state("developer", "idle")
        self.assertEqual((final["thread"], final["turn_requests"]), (first["thread"], 3))

    async def test_failed_ipc_request_preserves_daemon_and_current_turn(self):
        client = Client(self.store.home)
        receiver = asyncio.create_task(receive(self.service, client.box))
        try:
            await self.service.message(self.project, "coordinator", "hold")
            active = await self.wait(lambda: (row := self.service.session_for(self.project, "coordinator"))["turn"] and row)
            for raw in ({"args": {}, "action": "status", "deadline": "later"},
                        {"args": [], "action": "status", "deadline": time.time() + 5}):
                request = client.box / f"{uuid.uuid4().hex}.request"
                write(request, raw)
                response = await self.wait(lambda: request.with_suffix(".response").is_file()
                                           and request.with_suffix(".response"))
                self.assertIn("error", json.loads(response.read_text()))
            with patch.object(self.service, "status", side_effect=NameError("private diagnostic")):
                with self.assertRaisesRegex(ValueError, "NameError") as failure:
                    await asyncio.to_thread(client.call, "status", launch=False)
                self.assertNotIn("private diagnostic", str(failure.exception))
            status = await asyncio.to_thread(client.call, "status", launch=False, project=self.project)
            self.assertEqual(status["sessions"][0]["turn"], active["turn"])
            self.assertFalse(receiver.done())
        finally:
            await self.service.stop_all(immediate=True)
            await asyncio.wait_for(receiver, 12)

    async def test_reconnect_does_not_restart_daemon_or_turn(self):
        client_a = Client(self.store.home)
        daemon = asyncio.create_task(receive(self.service, client_a.box))
        try:
            await asyncio.to_thread(client_a.call, "send", launch=False, project=self.project,
                                    role="coordinator", text="hold")
            before = await self.wait(lambda: (row := self.service.session_for(self.project, "coordinator"))["turn"] and row)
            client_b = Client(self.store.home)
            status = await asyncio.to_thread(client_b.call, "status", launch=False, project=self.project)
            actual = status["sessions"][0]
            self.assertEqual((actual["thread"], actual["turn_requests"]), (before["thread"], 1))
        finally:
            await self.service.stop_all(immediate=True)
            await asyncio.wait_for(daemon, 12)


if __name__ == "__main__":
    unittest.main()
