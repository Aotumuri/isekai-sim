"""Resolve user-owned tracker policy and the checked-in project constraints."""

import json
from pathlib import Path
import tomllib

from .artifacts import read_result

PERMISSIONS = {"proposal": "create_issue", "comment": "comment", "progress": "update_issue",
               "depends": "update_issue", "label": "update_issue", "checklist": "update_issue",
               "complete": "close_issue"}
LEVELS = ("deny", "ask", "allow")


def project_tracker(project):
    try:
        page = read_result(Path(project["path"]) / "agents", "config.toml", size=65536)
    except FileNotFoundError:
        return None
    if page["next"] != page["total"]:
        raise ValueError("トラッカー設定ファイルが大きすぎます")
    settings = tomllib.loads(page["text"]).get("tracker", {})
    github = settings.get("github", {})
    if settings.get("backend") != "github" or github.get("repository") != project["github"]:
        return {}
    return github


def policy_map(value):
    # Before policy levels, the list recorded operations requiring review.
    if isinstance(value, list):
        value = dict.fromkeys(value, "ask")
    if (not isinstance(value, dict) or any(key not in PERMISSIONS or level not in LEVELS
                                          for key, level in value.items())):
        raise ValueError("操作ごとに allow、ask、deny を指定してください")
    return value


class TrackerPolicy:
    def set_tracker_policy(self, project, operations):
        repo = self.project(project)
        if not repo["github"]:
            raise ValueError("GitHub リポジトリを登録してください")
        operations = policy_map(operations)
        with self.store.db:
            self.store.db.execute("INSERT OR REPLACE INTO tracker_policy VALUES (?,?)",
                                  (project, json.dumps(operations, sort_keys=True)))
        return True

    def tracker_policy(self, project, kind):
        policy = self.store.one("SELECT operations FROM tracker_policy WHERE project=?", (project["id"],))
        central = policy_map(json.loads(policy["operations"])).get(kind, "deny") if policy else "deny"
        if project["archived"] or not project["github"] or central == "deny":
            return "deny"
        if getattr(self, "local_project", None) is not None:
            try:
                page = read_result(Path(project["path"]) / "adf", "policy.toml", size=65536)
            except FileNotFoundError:
                return central
            if page["next"] != page["total"]:
                raise ValueError("リポジトリの権限方針が大きすぎます")
            ceiling = policy_map(tomllib.loads(page["text"]).get("tracker", {})).get(kind, "deny")
            return LEVELS[min(LEVELS.index(central), LEVELS.index(ceiling))]
        configured = project_tracker(project)
        if configured is None:
            return central
        value = configured.get(PERMISSIONS[kind], "deny")
        # Legacy update_issue governs the fine-grained operations too.
        specific = configured.get(kind, value)
        return LEVELS[min(LEVELS.index(level) if level in LEVELS else 0 for level in (central, value, specific))]

    def tracker_allowed(self, project, kind):
        result = self.tracker_policy(project, kind)
        if result == "deny":
            raise ValueError("ADF またはプロジェクトのトラッカー操作ポリシーが禁止しています")
        return result
