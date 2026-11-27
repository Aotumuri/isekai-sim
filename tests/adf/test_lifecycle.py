"""Bounded process integration tests using a Codex CLI double."""

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

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1]


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / ".git").mkdir()
        shutil.copytree(SOURCE / "adf", self.root / "adf",
                        ignore=shutil.ignore_patterns("runtime", "queue", "requests", "__pycache__"))
        fake = self.root / "codex"
        shutil.copyfile(HERE / "fake_codex.py", fake)
        fake.chmod(0o700)
        self.env = os.environ.copy()
        for key in ("GH_TOKEN", "GITHUB_TOKEN", "CODEX_THREAD_ID"):
            self.env.pop(key, None)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]

    def process(self, *args):
        return subprocess.Popen(
            [sys.executable, "-m", "adf", *args], cwd=self.root, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

    def cli(self, *args):
        with self.process(*args) as child:
            stdout, stderr = child.communicate(timeout=12)
        self.assertEqual(child.returncode, 0, stderr)
        return stdout

    def stop(self, child):
        if child.poll() is None:
            child.send_signal(signal.SIGKILL)
        child.communicate(timeout=12)

    def start(self, *, enabled=True, profile="research"):
        args = ["start", "--profile", profile]
        if enabled:
            args.append("--enable-experiments")
        daemon = self.process(*args)
        self.addCleanup(self.stop, daemon)
        self.wait_for(lambda: (self.root / ".codex/adf/settings.json").exists())
        return daemon

    def wait_for(self, condition):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            value = condition()
            if value:
                return value
            time.sleep(0.05)
        self.fail("condition was not satisfied")

    def jobs(self):
        return json.loads(self.cli("status"))["jobs"]

    def test_independent_start_repeated_resume_fresh_thread_and_restart(self):
        daemon = self.start()
        self.assertEqual(self.jobs(), [])
        self.assertEqual(list(self.root.glob("context-*")), [])
        source = self.process("session", "start")
        self.addCleanup(self.stop, source)
        self.addCleanup((self.root / "release-source").touch)
        self.addCleanup((self.root / "release-experiment").touch)
        self.wait_for(lambda: (self.root / "source-accepted").exists())
        waiting = self.jobs()[0]
        self.assertEqual(waiting["state"], "waiting")
        self.assertIsNone(source.poll())
        self.assertFalse((self.root / "executions").exists())

        self.stop(daemon)
        (self.root / "release-source").touch()
        self.assertEqual(source.wait(timeout=12), 0)
        daemon = self.start_and_recover_experiment()

        self.cli("pause")
        (self.root / "release-experiment").touch()
        self.wait_for(lambda: self.jobs()[0]["state"] == "ready_codex")
        self.assertEqual(len(list(self.root.glob("context-*"))), 1)
        self.addCleanup((self.root / "release-fresh").touch)
        self.cli("unpause")
        self.wait_for(lambda: (self.root / "fresh-running").exists())
        self.stop(daemon)
        self.start()
        self.assertEqual(self.jobs()[-1]["state"], "codex")
        (self.root / "release-fresh").touch()
        jobs = self.wait_for(lambda: self.completed_chain())
        thread = waiting["request"]["thread"]
        self.assertEqual([row["codex_result"]["thread_id"] for row in jobs[:2]], [thread, thread])
        fresh = jobs[2]["codex_result"]["thread_id"]
        self.assertNotEqual(fresh, thread)
        self.assertEqual((self.root / f"context-{fresh}").read_text(), "fresh instruction")
        self.assertEqual(len(list(self.root.glob("context-*"))), 2)
        self.assertEqual(jobs[0]["experiment_result"]["exit_code"], 3)
        self.assertEqual(jobs[1]["experiment_result"]["exit_code"], 0)
        self.assertEqual((self.root / "executions").read_text().splitlines(), ["experiment", "quick --seed 42"])
        for job in jobs[:2]:
            log = self.root / ".codex/adf/jobs" / job["id"] / "codex.jsonl"
            self.assertIn('"original": "start"', log.read_text())
        self.assertFalse((SOURCE / ".codex/adf/jobs" / waiting["id"]).exists())

    def start_and_recover_experiment(self):
        daemon = self.start()
        self.wait_for(lambda: (self.root / "executions").exists())
        self.stop(daemon)
        restarted = self.start()
        self.assertEqual(self.jobs()[0]["state"], "experiment")
        self.assertIsNone(restarted.poll())
        return restarted

    def completed_chain(self):
        jobs = self.jobs()
        return jobs if len(jobs) == 3 and all(job["state"] == "done" for job in jobs) else None

    def test_failed_continuation_and_uncertain_experiment_are_never_retried(self):
        daemon = self.start()
        self.cli("session", "fail-continuation")
        self.wait_for(lambda: self.jobs()[0]["state"] == "continuation_failed")
        self.assertEqual(self.jobs()[0]["codex_result"]["exit_code"], 7)
        self.cli("session", "lose-worker")
        self.wait_for(lambda: self.jobs()[-1]["state"] == "uncertain")
        self.stop(daemon)
        self.start()
        self.assertEqual([job["state"] for job in self.jobs()], ["continuation_failed", "uncertain"])
        self.assertEqual((self.root / "executions").read_text().splitlines(), ["quick", "lose-worker"])

    def test_explicit_scope_and_official_denial(self):
        daemon = self.start(enabled=False)
        self.cli("session", "unauthorized")
        self.assertEqual(self.jobs(), [])
        self.cli("session", "spawn only")
        self.wait_for(lambda: self.jobs()[0]["state"] == "done")
        self.assertEqual(self.jobs()[0]["request"]["kind"], "spawn")
        self.stop(daemon)
        self.start()
        self.cli("session", "declined")
        self.wait_for(lambda: self.jobs()[-1]["state"] == "done")
        self.assertIsNone(self.jobs()[-1]["experiment_result"]["exit_code"])
        self.assertFalse((self.root / "executions").exists())

    def test_profile_change_blocks_previously_accepted_work(self):
        daemon = self.start()
        self.cli("pause")
        self.cli("session", "lose-worker")
        self.stop(daemon)
        self.start(profile="different")
        self.cli("unpause")
        self.wait_for(lambda: self.jobs()[0]["state"] == "blocked")
        self.assertFalse((self.root / "executions").exists())


if __name__ == "__main__":
    unittest.main()
