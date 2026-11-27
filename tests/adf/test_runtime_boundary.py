from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import AsyncMock

from adf.codex import COMMIT_PROFILE, Codex, profile_options


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

    async def test_commit_profile_is_selected_only_for_configured_developer_checkout(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            binary = root / "codex"
            runtime = Codex(binary, None, None, None, commit_root=str(root))
            default = tomllib.loads(profile_options(binary)[1])["permissions"]
            enabled = tomllib.loads(profile_options(binary, root)[1])["permissions"]
            self.assertNotIn(COMMIT_PROFILE, default)
            self.assertEqual({name: enabled[name] for name in default}, default)
            filesystem = enabled[COMMIT_PROFILE]["filesystem"]
            self.assertEqual(filesystem[":workspace_roots"][".git"], "read")
            self.assertEqual(filesystem[str(root / ".git/index.lock")], "write")
            self.assertEqual(filesystem[str(root / ".git/objects/info")], "read")
            self.assertNotIn(str(root / ".git/config"), filesystem)
            self.assertFalse(enabled[COMMIT_PROFILE]["network"]["enabled"])

            runtime.rpc = AsyncMock(return_value={"thread": {"id": "thread"}, "turn": {"id": "turn"}})
            settings = {"model": "", "effort": ""}
            row = {"role": "developer", "path": str(root), "thread": None}
            await runtime.thread(row, settings, "")
            self.assertEqual(runtime.rpc.await_args.args[1]["permissions"], COMMIT_PROFILE)
            await runtime.thread({**row, "thread": "thread"}, settings, "")
            self.assertEqual(runtime.rpc.await_args.args[1]["permissions"], COMMIT_PROFILE)
            for changes, expected in (
                ({}, COMMIT_PROFILE),
                ({"role": "coordinator"}, "adf-reader"),
                ({"discovery": True}, "adf-reader"),
                ({"path": str(root / "other")}, "adf-writer"),
            ):
                await runtime.start({**row, "thread": "thread", **changes}, settings, "")
                params = runtime.rpc.await_args.args[1]
                self.assertEqual(params["permissions"], expected)
                self.assertEqual(params["approvalPolicy"], "never")
