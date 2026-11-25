import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

TOOLS = Path(__file__).resolve().parents[1]


class FrameworkTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tools = self.root / "agents/tools"
        self.tools.mkdir(parents=True)
        self.research = self.root / "agents/research"
        self.research.mkdir()
        for path in TOOLS.glob("*.py"):
            shutil.copy(path, self.tools / path.name)
        self.write_config()
        self.save(self.research / "state.json", {"version": 1, "tasks": {}, "reviews": {}})
        self.git("init", "-q")
        (self.root / "source.txt").write_text("committed")
        self.git("add", "source.txt")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture")
        self.revision = self.git("rev-parse", "HEAD").stdout.strip()

    def write_config(self, *, auto_resume=False, codex_cli_path=""):
        (self.tools.parent / "config.toml").write_text(
            '[tracker]\nbackend = "local"\n'
            f'[execution]\nauto_resume = {str(auto_resume).lower()}\n'
            f'codex_cli_path = {json.dumps(codex_cli_path)}\n'
        )

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True,
                              capture_output=True, text=True)

    def save(self, path, content):
        path.write_text(json.dumps(content), encoding="utf-8")

    def call(self, tool, *args, body=None, check=True, env=None):
        return subprocess.run([sys.executable, str(self.tools / (tool + ".py")), *args],
                              cwd=self.root, text=True, input=body, capture_output=True,
                              check=check, env=env)

    def task(self, *args, **kwargs):
        return self.call("research", *args, **kwargs).stdout.strip()

    def manifest(self, job):
        return self.root / "agents/runtime/jobs" / job / "manifest.json"

    def wait_for(self, job, predicate, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = json.loads(self.manifest(job).read_text())
            if predicate(state):
                return state
            time.sleep(0.05)
        self.fail(f"job {job} did not reach its expected state: {state}")

    def start(self, job, code, *options, timeout=12, **kwargs):
        return self.call("runner", "start", job, "--timeout", str(timeout),
                         *options, "--", sys.executable, "-c", code, **kwargs)

    def done(self, job):
        return self.wait_for(job, lambda state: "ended_at" in state)

    def test_concurrent_intake_review_and_handoff(self):
        def submit(index):
            return self.task("submit", f"Idea {index}", "--assessment", "investigate",
                             body="A proposal for evaluation.")
        with ThreadPoolExecutor(max_workers=6) as pool:
            ideas = list(pool.map(submit, range(8)))
        self.assertEqual(len(set(ideas)), 8)
        self.assertEqual(len(json.loads(self.task("status"))["unreviewed"]), 8)
        self.task("claim", "original")
        self.assertNotEqual(self.call("research", "claim", "replacement", check=False).returncode, 0)
        self.task("review", "original", ideas[0], "deferred", "Needs evidence")
        self.task("review", "original", ideas[1], "rejected", "Contradicts project policy")
        self.task("review", "original", ideas[0], "ready", "Evidence now supplied")
        self.task("checkpoint", "original", ideas[0], "active", "Validate comparison")
        self.assertNotEqual(self.call("research", "checkpoint", "original", ideas[0], "waiting",
                                      "Missing job", "--job", "unknown", check=False).returncode, 0)
        self.task("handoff", "replacement", "original")
        self.assertNotEqual(self.call("research", "checkpoint", "original", ideas[0], "done",
                                      "Stale owner", check=False).returncode, 0)
        self.task("checkpoint", "replacement", ideas[0], "done", "Report completed")
        self.assertNotEqual(self.call("research", "checkpoint", "replacement", ideas[0], "active",
                                      "Do not repeat", check=False).returncode, 0)
        state = json.loads(self.task("status"))
        self.assertEqual(state["tasks"][ideas[0]]["status"], "done")
        self.assertEqual(state["reviews"][ideas[1]]["outcome"], "rejected")
        self.assertEqual(len(state["unreviewed"]), 6)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.revision)

    def test_detached_jobs_fixed_revision_and_no_duplicate_execution(self):
        (self.root / "source.txt").write_text("unrelated local edit")
        code = ("import time; from pathlib import Path; time.sleep(2); "
                "print(Path('source.txt').read_text())")
        self.start("long", code)
        self.start("failed", "raise SystemExit(17)")
        self.assertNotEqual(self.start("long", code, check=False).returncode, 0)
        self.assertEqual(self.done("failed")["exit_code"], 17)
        result = self.done("long")
        self.assertEqual((result["status"], result["revision"]), ("succeeded", self.revision))
        self.assertEqual((self.manifest("long").parent / result["log"]).read_text().strip(), "committed")
        self.assertEqual((self.root / "source.txt").read_text(), "unrelated local edit")

    def test_cancel_timeout_and_recover(self):
        self.start("cancel", "import time; time.sleep(30)")
        self.wait_for("cancel", lambda state: state["status"] == "running")
        self.call("runner", "cancel", "cancel")
        self.assertEqual(self.done("cancel")["status"], "cancelled")
        self.start("timeout", "import time; time.sleep(30)", timeout=1)
        self.assertEqual(self.done("timeout")["status"], "timed_out")
        # An abandoned running manifest with neither supervisor nor child holding the lease.
        saved = self.manifest("timeout")
        state = json.loads(saved.read_text())
        self.call("runner", "recover", "timeout")
        state.update(status="running")
        self.save(saved, state)
        self.assertEqual(json.loads(self.call("runner", "recover", "timeout").stdout)["status"],
                         "interrupted")

    def test_acceptance_probe_requires_explicit_positive_timeout_and_current_owner(self):
        self.task("claim", "fixture")
        cases = (
            ("missing-timeout", ["--notify-thread", "fixture"], "--timeout"),
            ("zero-timeout", ["--timeout", "0", "--notify-thread", "fixture"], "positive integer"),
            ("infinite-timeout", ["--timeout", "inf", "--notify-thread", "fixture"], "--timeout"),
            ("missing-target", ["--timeout", "330"], "requires --notify-thread"),
            ("wrong-owner", ["--timeout", "330", "--notify-thread", "other"], "current Developer owner"),
        )
        for job, options, error in cases:
            with self.subTest(job=job):
                result = self.call("runner", "start", job, "--acceptance-probe", *options,
                                   "--", sys.executable, "-c", "pass", check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertFalse(self.manifest(job).parent.exists())

    def test_notification_cli_preference_and_portable_fallback(self):
        configured = self.root / "standalone"
        on_path = self.root / "codex"
        bundled = self.root / "bundled"
        for path in (configured, on_path, bundled):
            path.write_text("#!/bin/sh\nprintf '%s\\n' "
                            "'Queue a message for an existing session --thread --message --resume'\n")
            path.chmod(0o700)
        self.write_config(codex_cli_path=str(configured))
        env = {**os.environ, "PATH": str(self.root), "CODEX_APP_RUNTIME_CLI_PATH": str(bundled)}
        env.pop("CODEX_CLI_PATH", None)

        def selected_cli():
            result = self.call("runner", "capabilities", env=env)
            return json.loads(result.stdout)["notification_cli"]

        self.assertEqual(selected_cli(), str(configured))
        configured.unlink()
        self.assertEqual(selected_cli(), str(on_path))
        on_path.write_text("#!/bin/sh\nexit 1\n")
        self.assertEqual(selected_cli(), str(bundled))
        env["CODEX_CLI_PATH"] = str(configured)
        self.assertIsNone(selected_cli())

    def test_notification_result_and_recovery_do_not_send_twice(self):
        fake = self.root / "fake-codex"
        marker = self.root / "deliveries"
        environment = {**os.environ, "CODEX_CLI_PATH": str(fake),
                       "DELIVERIES": str(marker)}
        self.task("claim", "fixture")
        cases = (("probe-accepted", 0, "accepted", True),
                 ("probe-failed", 9, "failed", True),
                 ("ordinary-accepted", 0, "accepted", False))
        for job, exit_code, status, probe in cases:
            self.write_config(auto_resume=not probe)
            fake.write_text("#!/bin/sh\nif [ \"$1\" = help ]; then\n"
                            "  echo 'Queue a message for an existing session --thread --message --resume'\n"
                            "  exit 0\nfi\nprintf 'attempt\\n' >> \"$DELIVERIES\"\n"
                            "printf '%s\\n' \"$@\"\n"
                            f"exit {exit_code}\n")
            fake.chmod(0o700)
            options = ["--acceptance-probe"] if probe else []
            self.start(job, "print('short job')", "--notify-thread", "fixture",
                       *options, timeout=330, env=environment)
            state = self.wait_for(job, lambda entry: entry["notification"]["status"] == status)
            self.assertEqual(state["status"], "succeeded")
            self.assertEqual(state["timeout_s"], 330)
            self.call("runner", "recover", job, env=environment)
            if status == "accepted":
                generation = state["notification"]["generation"]
                args = (self.manifest(job).parent / "notification.log").read_text().splitlines()
                self.assertEqual(args[:5], ["queue", "--resume", "--thread", "fixture", "--message"])
                self.assertIn(f"validate-wake {job} {generation}", args[5])
                self.assertEqual("end the turn without starting research" in args[5], probe)
                self.assertEqual(state["notification"]["wake_scope"], "research")
                self.call("control", "validate-wake", job, generation)
                self.assertNotEqual(self.call("control", "validate-wake", job, generation,
                                              check=False).returncode, 0)
        self.assertEqual(marker.read_text().splitlines(), ["attempt"] * len(cases))

    def test_stop_drain_resume_and_stale_notification(self):
        self.write_config(auto_resume=False)
        fake = self.root / "fake-codex"
        fake.write_text("#!/bin/sh\nif [ \"$1\" = help ]; then\n"
                        " echo 'Queue a message for an existing session --thread --message --resume'\n"
                        "else\n exit 99\nfi\n")
        fake.chmod(0o700)
        env = {**os.environ, "CODEX_CLI_PATH": str(fake)}
        self.task("claim", "fixture")
        denied = self.start("denied", "pass", "--notify-thread", "fixture", check=False, env=env)
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn("Automatic continuation is disabled by repository policy", denied.stderr)
        self.assertFalse(self.manifest("denied").parent.exists())
        self.start("drained", "import time; time.sleep(1)", "--notify-thread", "fixture",
                   "--acceptance-probe", env=env)
        self.call("control", "drain", "test")
        self.assertNotEqual(self.start("denied", "pass", check=False).returncode, 0)
        drained = self.wait_for("drained", lambda m: m["notification"]["status"] == "suppressed")
        self.assertEqual(drained["status"], "succeeded")
        self.assertEqual(json.loads(self.call("control", "status").stdout)["mode"], "paused")
        self.call("control", "pause", "test")
        self.assertNotEqual(self.start("denied", "pass", check=False).returncode, 0)
        (self.root / "source.txt").write_text("undelivered source edits")
        recovery = json.loads(self.call("control", "resume", "owner instruction").stdout)
        self.assertIn(" M source.txt", recovery["recovery"]["changes"])
        old = drained["notification"]["generation"]
        self.assertNotEqual(self.call("control", "validate-wake", "drained", old,
                                      check=False).returncode, 0)
        self.start("stopped", "import time; time.sleep(20)", "--notify-thread", "fixture",
                   "--acceptance-probe", env=env)
        self.call("control", "stop", "test")
        stopped = self.wait_for("stopped", lambda m: m["notification"]["status"] == "suppressed")
        self.assertEqual(stopped["status"], "cancelled")

    def test_child_process_group_cancel_and_artifacts(self):
        code = """import os, subprocess, sys, time
from pathlib import Path
root = Path(os.environ['EXPERIMENT_ARTIFACTS'])
subprocess.Popen([sys.executable, '-c', '''
import signal, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path("ready").touch()
time.sleep(3)
Path("survived").touch()
'''], cwd=root)
print('out', flush=True)
print('err', file=sys.stderr, flush=True)
assert sys.stdin.read() == ''
time.sleep(20)
"""
        self.start("group", code)
        result_path = self.manifest("group").parent
        deadline = time.monotonic() + 5
        while not (result_path / "artifacts/ready").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue((result_path / "artifacts/ready").exists())
        self.call("runner", "cancel", "group")
        self.assertEqual(self.done("group")["status"], "cancelled")
        time.sleep(3)
        self.assertFalse((result_path / "artifacts/survived").exists())
        self.assertEqual((result_path / "experiment.log").read_text().splitlines(), ["out", "err"])

    def test_graceful_external_wake_only_finalizes_and_new_thread_can_resume(self):
        self.write_config(auto_resume=True)
        fake = self.root / "fake-codex"
        fake.write_text("#!/bin/sh\nif [ \"$1\" = help ]; then\n"
                        " echo 'Queue a message for an existing session --thread --message --resume'\n"
                        "else\n printf '%s\\n' \"$@\"\nfi\n")
        fake.chmod(0o700)
        env = {**os.environ, "CODEX_CLI_PATH": str(fake)}
        self.task("claim", "first")
        self.start("graceful", "import time; time.sleep(2); print('result')",
                   "--notify-thread", "first", env=env)
        initial = json.loads(self.manifest("graceful").read_text())["notification"]["generation"]
        shutdown = json.loads(self.call("control", "graceful", "owner request").stdout)
        self.assertEqual(shutdown["mode"], "stopping")
        self.assertNotEqual(self.start("forbidden", "pass", check=False).returncode, 0)
        self.assertNotEqual(self.call("control", "finalize", "too soon", check=False).returncode, 0)
        result = self.wait_for("graceful", lambda m: m["notification"]["status"] == "accepted")
        self.assertEqual(result["notification"]["wake_scope"], "shutdown")
        self.assertNotEqual(self.call("control", "validate-wake", "graceful", initial,
                                      check=False).returncode, 0)
        valid = json.loads(self.call("control", "validate-wake", "graceful",
                                     shutdown["generation"]).stdout)
        self.assertEqual(valid["wake_scope"], "shutdown")
        self.assertNotEqual(self.start("still-forbidden", "pass", check=False).returncode, 0)
        stopped = json.loads(self.call("control", "finalize", "results reviewed").stdout)
        self.assertEqual(stopped["handover"]["jobs"][0]["status"], "succeeded")
        recovery = json.loads(self.call("control", "resume", "owner request", "--owner", "second",
                                        "--previous-owner", "first").stdout)
        self.assertEqual(recovery["mode"], "running")
        self.assertEqual(recovery["previous_shutdown"]["handover"]["note"], "results reviewed")
        self.assertEqual(json.loads(self.task("status"))["owner"], "second")

    def test_immediate_escalation_and_preserves_partial_result(self):
        self.start("partial", "import time; print('partial', flush=True); time.sleep(20)")
        job = self.manifest("partial").parent
        deadline = time.monotonic() + 5
        log = job / "experiment.log"
        while time.monotonic() < deadline and (not log.exists() or not log.read_text()):
            time.sleep(0.05)
        self.assertEqual(log.read_text().strip(), "partial")
        self.call("control", "graceful", "safe finish")
        self.call("control", "emergency-stop", "owner needs shutdown")
        self.assertEqual(self.done("partial")["status"], "cancelled")
        self.assertEqual(log.read_text().strip(), "partial")
        state = json.loads(self.call("control", "status").stdout)
        self.assertEqual((state["mode"], state["shutdown"]), ("stopped", "immediate"))

    def test_graceful_without_notifier_and_implementation_boundary(self):
        self.task("claim", "original")
        idea = self.task("submit", "Test", "--assessment", "ready", body="Scope")
        self.task("review", "original", idea, "ready", "Verify")
        self.task("checkpoint", "original", idea, "active", "implementation")
        (self.root / "source.txt").write_text("uncommitted")
        self.call("control", "graceful", "testing soon")
        self.task("checkpoint", "original", idea, "active", "implementation partial, validate on resume")
        self.call("control", "finalize", "handover")
        self.assertEqual((self.root / "source.txt").read_text(), "uncommitted")
        self.call("control", "resume", "continue", "--owner", "original")
        self.start("no-wake", "import time; time.sleep(1); print('completed')")
        self.call("control", "graceful", "wait on external job")
        self.done("no-wake")
        # The runner settles the lifecycle after writing the terminal manifest.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = json.loads(self.call("control", "status").stdout)
            if state["mode"] == "stopped":
                break
            time.sleep(0.05)
        self.assertEqual(state["mode"], "stopped")
        self.assertEqual(state["handover"]["jobs"][0]["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
