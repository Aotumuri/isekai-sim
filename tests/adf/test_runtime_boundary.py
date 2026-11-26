from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import AsyncMock

from adf.codex import Codex, profile_options


class RuntimeProtocol(unittest.IsolatedAsyncioTestCase):
    def test_profiles_deny_legacy_runtime_and_keep_default_filesystem_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp).resolve() / "codex"
            executable = binary.with_name("codex-binary")
            executable.touch()
            binary.symlink_to(executable)
            profiles = tomllib.loads(profile_options(binary)[1])["permissions"]
        for name, access in (("adf-reader", "read"), ("adf-writer", "write"), ("adf-experiment", "write")):
            filesystem = profiles[name]["filesystem"]
            self.assertEqual(filesystem[":root"], "deny")
            self.assertEqual(filesystem[":workspace_roots"]["."], access)
            self.assertEqual(filesystem[":workspace_roots"]["agents/runtime"], "deny")
            self.assertNotIn(str(binary), filesystem)
            self.assertEqual(filesystem[str(executable)], "read")

    async def test_thread_start_and_resume_disable_only_legacy_role_skills(self):
        runtime = Codex(None, None, None, None)
        root = Path(__file__).resolve().parents[2]
        legacy_path = str(root / ".agents/skills/developer/SKILL.md")
        other_skill = {"name": "unrelated", "enabled": False}
        effective = {"config": {"skills": {"config": [
            other_skill, {"path": legacy_path, "enabled": True},
        ]}}}
        runtime.rpc = AsyncMock(side_effect=[
            effective, {"thread": {"id": "current"}}, effective, {"thread": {"id": "current"}},
        ])
        settings = {"model": ""}
        row = {"role": "developer", "path": str(root), "thread": None}
        await runtime.thread(row, settings, "Desktop instructions")
        method, start = runtime.rpc.await_args.args
        self.assertEqual(method, "thread/start")
        self.assertEqual(start["developerInstructions"], "Desktop instructions")
        expected = [other_skill] + [
            {"path": str(root / f".agents/skills/{role}/SKILL.md"), "enabled": False}
            for role in ("coordinator", "developer")
        ]
        self.assertEqual(start["config"]["skills.config"], expected)
        self.assertEqual({tool["name"] for tool in start["dynamicTools"]}, {
            "adf_start_experiment", "adf_research_experiment", "adf_finish_research_task",
            "adf_read_experiment_output", "adf_read_github_issue", "adf_draft_github",
        })
        await runtime.thread({**row, "thread": "current"}, settings, "Desktop instructions")
        method, resume = runtime.rpc.await_args.args
        self.assertEqual(method, "thread/resume")
        self.assertEqual(resume["config"], start["config"])
        self.assertNotIn("dynamicTools", resume)
