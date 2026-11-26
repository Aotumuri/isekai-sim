"""Validated host operations exposed to the human's desktop and CLI clients."""

import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import sys

from .codex import PATH, Codex, RuntimeError
from .discovery import Discovery
from .evidence import Evidence
from .experiments import Experiments
from .git_review import GitReview
from .github_research import GitHubResearch
from .legacy import Legacy
from .presets import Presets
from .projects import clean_name, identify, issues
from .research import Research
from .sessions import Sessions
from .store import ACTIVE
from .tracker import GitHub
from .tracker_policy import policy_map
from .usage import Usage


class Service(Presets, Legacy, GitHubResearch, GitHub, GitReview, Evidence, Usage, Discovery, Research,
              Experiments, Sessions):
    def __init__(self, store, binary, runtime_factory=None, lease=None):
        super().__init__(store, runtime_factory or (lambda *callbacks: Codex(binary, *callbacks, lease=lease)))
        self.binary = binary
        self.local_project = None
        self.local_config = None
        self.executing = set()
        self.cancelled_jobs = set()
        self.stop_epochs = {}
        self.tracker_sending = set()

    async def register(self, path, name="", github=""):
        path, identity = await identify(Path(path).expanduser().resolve(strict=True))
        protected = [
            self.store.home, Path(__file__).resolve().parent, Path(sys.executable).resolve(),
            Path(self.binary).resolve(), Path.home() / ".codex", Path.home() / ".config/gh",
            *(Path(part).resolve() for part in PATH.split(":")),
            *(Path(os.environ[key]).expanduser().resolve()
              for key in ("CODEX_HOME", "CODEX_SQLITE_HOME") if key in os.environ),
        ]
        if any(item.is_relative_to(path) or path.is_relative_to(item) for item in protected):
            raise ValueError("ADF の実行ファイル、認証情報、状態領域から独立したプロジェクトを選択してください")
        if github and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", github):
            raise ValueError("GitHub リポジトリは owner/name で指定してください")
        with self.store.db:
            existing = self.store.one("SELECT * FROM project WHERE path=?", (str(path),))
            if existing and existing["identity"] != identity:
                raise ValueError("同じ場所に別の Git リポジトリが存在します")
            for project in self.store.all("SELECT * FROM project WHERE archived=0 AND path<>?", (str(path),)):
                other = Path(project["path"])
                if path.is_relative_to(other) or other.is_relative_to(path):
                    raise ValueError("入れ子のプロジェクトは登録できません")
            self.store.db.execute("INSERT INTO project(name,path,identity,github) VALUES (?,?,?,?) "
                                  "ON CONFLICT(path) DO UPDATE SET name=excluded.name,github=excluded.github,archived=0",
                                  (name.strip() or path.name, str(path), identity, github))
        return self.store.one("SELECT * FROM project WHERE path=?", (str(path),))

    def project(self, project):
        row = self.store.one("SELECT * FROM project WHERE id=?", (project,))
        if not row:
            raise ValueError("プロジェクトを選択してください")
        return row

    def archive(self, project):
        self.project(project)
        sessions = self.store.all("SELECT id,state FROM session WHERE project=?", (project,))
        if any(row["state"] in ACTIVE or self.active_jobs(row["id"]) for row in sessions):
            raise ValueError("すべてのロールを停止してからアーカイブしてください")
        with self.store.db:
            self.store.db.execute("UPDATE project SET archived=1 WHERE id=?", (project,))
        return True

    def set_role(self, name, instructions="", model="", effort="", recovery="manual", budget=0):
        clean_name(name)
        if any(row["state"] in ACTIVE for row in self.store.all("SELECT state FROM session WHERE role=?", (name,))):
            raise ValueError("ロールを停止してから設定を変更してください")
        if recovery not in {"manual", "confirmed"} or type(budget) is not int or budget < 0:
            raise ValueError("利用枠の回復設定または予算が不正です")
        if any(not isinstance(text, str) for text in (instructions, model, effort)):
            raise ValueError("指示・モデル・推論設定は文字列で指定してください")
        with self.store.db:
            self.store.db.execute("INSERT INTO role VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET "
                                  "instructions=excluded.instructions,model=excluded.model,effort=excluded.effort,"
                                  "recovery=excluded.recovery,budget=excluded.budget",
                                  (name, instructions, model, effort, recovery, budget))
        # New instructions are supplied on resume after reconnect to the runtime.
        for row in self.store.all("SELECT thread FROM session WHERE role=?", (name,)):
            self.live.pop(row["thread"], None)
        return True

    def set_template(self, project, name, argv, timeout):
        self.project(project)
        clean_name(name)
        if (not isinstance(argv, list) or not argv or
                any(not isinstance(arg, str) or "\0" in arg for arg in argv) or not argv[0]):
            raise ValueError("実験のコマンドは空でない JSON 文字列配列で指定してください")
        if type(timeout) is not int or not 1 <= timeout <= 86400:
            raise ValueError("実験の上限時間は 1～86400 秒です")
        with self.store.db:
            self.store.db.execute("INSERT OR REPLACE INTO template VALUES (?,?,?,?)",
                                  (project, name, json.dumps(argv), timeout))
        return True

    def status(self, project=None, after=0):
        tracker = self.store.one("SELECT operations FROM tracker_policy WHERE project=?", (project,))
        return {
            "mission": (self.local_config or {}).get("mission", ""),
            "research_preset": self.saved_preset(project),
            "tracker_policy": policy_map(json.loads(tracker["operations"])) if tracker else {},
            "legacy_imports": self.store.all("SELECT fingerprint,path FROM legacy_import WHERE project=?", (project,)),
            "tracker_operations": self.store.all("SELECT * FROM tracker_operation WHERE project=? "
                                                 "ORDER BY created DESC LIMIT 100", (project,)),
            "research_tasks": self.store.all("SELECT * FROM research_task WHERE project=? AND id NOT IN (SELECT task FROM github_task) ORDER BY priority,id", (project,)),
            "github_runs": self.store.all("SELECT github_run.* FROM github_run JOIN session "
                                           "ON session.id=github_run.session WHERE project=?", (project,)),
            "research_runs": self.store.all("SELECT research_run.* FROM research_run JOIN session "
                                           "ON session.id=research_run.session WHERE project=?", (project,)),
            "projects": self.store.all("SELECT * FROM project WHERE archived=0 ORDER BY id"),
            "roles": self.store.all("SELECT * FROM role ORDER BY name"),
            "sessions": self.store.all("SELECT id,project,role,state,thread,turn,revision,tokens,turn_requests "
                                       "FROM session WHERE project=? ORDER BY role", (project,)),
            "jobs": self.store.all("SELECT job.* FROM job JOIN session ON session.id=job.session "
                                   "WHERE session.project=? ORDER BY started DESC LIMIT 100", (project,)),
            "events": self.store.all("SELECT event.* FROM event LEFT JOIN session ON session.id=event.session "
                                     "WHERE (session.project=? OR event.session IS NULL) AND event.id>? "
                                     "ORDER BY event.id LIMIT 250", (project, after)),
            "templates": self.store.all("SELECT * FROM template WHERE project=? ORDER BY name", (project,)),
            "shutting_down": self.shutdown,
        }

    def history(self, project, after=0, before=None):
        self.project(project)
        if type(after) is not int or (before is not None and type(before) is not int):
            raise ValueError("履歴の位置が不正です")
        return list(reversed(self.store.all(
            "SELECT event.*,session.role FROM event LEFT JOIN session ON session.id=event.session "
            "WHERE (session.project=? OR event.session IS NULL) AND event.id>? "
            "AND (? IS NULL OR event.id<?) ORDER BY event.id DESC LIMIT 200",
            (project, after, before, before))))

    def conversation(self, project, role, before=None):
        self.project(project)
        self.settings(role)
        if before is not None and type(before) is not int:
            raise ValueError("会話の位置が不正です")
        return list(reversed(self.store.all(
            "SELECT conversation.id,speaker,text FROM conversation JOIN session ON session.id=conversation.session "
            "WHERE project=? AND role=? AND (? IS NULL OR conversation.id<?) "
            "ORDER BY conversation.id DESC LIMIT 40", (project, role, before, before))))

    def read_log(self, job):
        if not self.store.one("SELECT id FROM job WHERE id=?", (job,)):
            raise ValueError("実験を選択してください")
        path = self.log_path(job)
        return path.read_text(errors="replace") if path.is_file() else ""

    async def stop_role(self, project, role, immediate=False):
        self.project(project)
        if role == "developer":
            self.stop_epochs[project] = self.stop_epochs.get(project, 0) + 1
        row = self.session_for(project, role)
        if row:
            await self.stop(row["id"], immediate)
        return True

    async def stop_all(self, immediate=False):
        self.shutdown = True
        for row in self.store.all("SELECT id FROM session"):
            await self.stop(row["id"], immediate)
        return True

    async def resume_role(self, project, role, text=""):
        row = self.session_for(project, role)
        if not row:
            raise ValueError("再開するセッションがありません")
        if role == "developer" and self.store.one(
                "SELECT 1 FROM research_run WHERE session=?",
                (row["id"],)):
            raise ValueError("研究の再開は research-resume で範囲と承認を照合してください。新しい相談はメッセージを送信してください")
        return self.reserve(project, role, text or row["prompt"], True)

    def maintenance(self, action, args):
        from .local import read_config, save_config
        from .maintenance import backup

        config = self.store.home / "config.toml"
        if action == "config-text":
            read_config(config)
            return config.read_text(encoding="utf-8")
        if self.shutdown or self.executing or self.tracker_sending or any(
                row["state"] in ACTIVE or self.active_jobs(row["id"])
                for row in self.store.all("SELECT id,state FROM session")):
            raise ValueError("先にロールを停止し、実験と送信の終了を確認してください")
        if action == "config-save":
            return save_config(self.store.home, args.get("content"))
        return backup(self.store.home)

    async def dispatch(self, action, args):
        operations = {
            "register": self.register, "archive": self.archive, "role": self.set_role,
            "template": self.set_template, "status": self.status, "log": self.read_log,
            "send": self.message, "stop": self.stop_role, "resume": self.resume_role,
            "shutdown": self.stop_all, "issues": self.list_issues, "limits": self.get_limits, "models": self.list_models,
            "task": self.add_task, "task-reopen": self.reopen_task, "research-start": self.start_project_research, "research-resume": self.resume_project_research,
            "artifacts": self.artifacts, "experiment-inputs": self.experiment_inputs,
            "commit-preview": self.commit_preview, "usage": self.usage_report, "tracker-policy": self.set_tracker_policy,
            "tracker-draft": self.draft_tracker, "tracker-review": self.review_tracker, "tracker-reconcile": self.reconcile_tracker,
            "tracker-issue": self.tracker_issue, "research-preset": self.research_preset,
            "legacy-preview": self.legacy_preview, "legacy-import": self.legacy_import, "history": self.history, "conversation": self.conversation,
        }
        operations_project = {"template", "status", "send", "stop", "resume", "issues", "research-start",
                              "research-resume", "commit-preview", "usage", "tracker-policy", "tracker-draft",
                              "tracker-issue", "research-preset", "legacy-preview", "legacy-import", "history", "conversation"}
        if self.local_project is not None:
            if action in {"register", "archive", "task", "task-reopen"}:
                raise ValueError("プロジェクト内 ADF は設定された GitHub Issues を使用します")
            if action == "config":
                return self.local_config
            if action in {"config-text", "config-save", "backup"}:
                return self.maintenance(action, args)
            if action == "ping":
                return {"running": True, "pid": os.getpid(), "project": self.project(self.local_project)}
            if action in operations_project:
                if args.get("project") not in (None, self.local_project):
                    raise ValueError("このチェックアウトのプロジェクトを指定してください")
                args = {**args, "project": self.local_project}
        if self.shutdown and action in {
                "send", "resume", "research-start", "research-resume", "tracker-review",
                "tracker-draft", "tracker-policy", "role", "template"}:
            raise ValueError("監督は停止処理中です")
        if action not in operations:
            raise ValueError("未対応の操作です")
        result = operations[action](**args)
        return await result if asyncio.iscoroutine(result) else result

    async def list_models(self):
        runtime = await self.connect()
        models, cursors = [], set()
        cursor = None
        while True:
            page = await runtime.rpc("model/list", {"cursor": cursor, "limit": 100}, timeout=5)
            models.extend(row for row in page["data"] if not row.get("hidden"))
            cursor = page["nextCursor"]
            if not cursor or cursor in cursors:
                return models
            cursors.add(cursor)
            if len(cursors) >= 5:
                return models

    async def list_issues(self, project):
        return await issues(self.project(project)["github"])

    def is_stopped(self):
        return (self.shutdown and not self.dispatching and not self.executing
                and not self.tracker_sending and not self.store.one(
            "SELECT id FROM session WHERE state IN ('running','waiting','draining','stopping','quota','idle')"))

    async def close(self):
        if self.runtime:
            await self.runtime.close()
        if self.retiring:
            await asyncio.shield(self.retiring)
        for task in self.tasks.copy():
            task.cancel()
        await asyncio.gather(*self.tasks.copy(), return_exceptions=True)
        for lease in self.legacy_leases.values():
            lease.__exit__(None, None, None)
        self.legacy_leases.clear()


def runtime_path():
    result = shutil.which("codex", path=PATH)
    if not result:
        raise RuntimeError("公式 Codex CLI をインストールしてください")
    return str(Path(result).resolve())
