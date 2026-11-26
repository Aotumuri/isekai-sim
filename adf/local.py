"""Resolve a project installation and validate its operator-owned configuration."""

import json
import os
from pathlib import Path
import re
import shutil
import tomllib
from tempfile import NamedTemporaryFile

from .presets import PRESETS, preset_config
from .store import DESKTOP_TRANSFER, owner_lock, private_dir
from .tracker_policy import policy_map

INSTALLATION = Path(__file__).resolve().parent.parent
PROJECT = 1
GIT_OPERATIONS = ("commit", "push", "pull_request", "destructive_history_operations")


def git_settings(data):
    if not isinstance(data, dict) or set(data) - {*GIT_OPERATIONS, "require_commit"}:
        raise ValueError("git テーブルの設定項目を確認してください")
    policy = {name: data.get(name, "deny") for name in GIT_OPERATIONS}
    for name, decision in policy.items():
        if decision not in ("allow", "ask", "deny"):
            raise ValueError(f"git.{name} は allow / ask / deny で指定してください")
        if decision != "deny":
            raise ValueError(f"git.{name}={decision} は現在の管理プロファイルでは強制できません")
    required = data.get("require_commit", False)
    if type(required) is not bool:
        raise ValueError("git.require_commit は真偽値で指定してください")
    return {**policy, "require_commit": required}


def home_for(root):
    package = root / "adf"
    if package.is_symlink() or not (package / "config.example.toml").is_file():
        raise ValueError("このチェックアウトにプロジェクト内 ADF が導入されていません")
    return package / "runtime"


def read_config(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("運用設定がありません。python3 -m adf init を実行してください")
    if path.stat().st_size > 65536:
        raise ValueError("運用設定が大きすぎます")
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    if set(data) - {"project", "research", "tracker", "git"}:
        raise ValueError("運用 TOML のセクションを確認してください")
    project = data.get("project", {})
    research = data.get("research", {})
    if not isinstance(project, dict) or not isinstance(research, dict):
        raise ValueError("project と research は TOML テーブルで指定してください")
    if set(project) - {"name", "github", "mission"} or set(research) - {
            "mode", "jobs", "turns", "tokens", "timeout", "recovery", "empty_queue", "discovery_issue"}:
        raise ValueError("運用 TOML に未対応の項目があります")
    name, github, mission = (project.get(key, "") for key in ("name", "github", "mission"))
    if not all(isinstance(value, str) for value in (name, github, mission)):
        raise ValueError("プロジェクト名、GitHub リポジトリ、Mission は文字列で指定してください")
    if github and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", github):
        raise ValueError("GitHub リポジトリは owner/name で指定してください")
    if len(name) > 100 or len(mission) > 4000:
        raise ValueError("プロジェクト名または Mission が長すぎます")
    mode = research.get("mode", "manual")
    if not isinstance(mode, str) or mode not in PRESETS:
        raise ValueError("運用モードを確認してください")
    preset = preset_config(mode, {key: value for key, value in research.items() if key != "mode"},
                           require_tokens=False)
    tracker = policy_map(data["tracker"]) if "tracker" in data else None
    return {"name": name, "github": github, "mission": mission, "preset": preset, "tracker": tracker,
            "git": git_settings(data.get("git", {}))}


def setup(root, source=None, *, replace=False):
    home = private_dir(home_for(root))
    config = home / "config.toml"
    source = Path(source) if source else root / "adf/config.example.toml"
    read_config(source)
    with owner_lock(home):
        if config.exists() and not replace:
            return read_config(config)
        return save_config(home, source.read_text(encoding="utf-8"))


def save_config(home, content):
    if not isinstance(content, str) or len(content.encode()) > 65536:
        raise ValueError("運用 TOML を 64 KiB 以内で指定してください")
    with NamedTemporaryFile(dir=home, prefix=".config-", delete=False) as stream:
        staging = Path(stream.name)
        try:
            stream.write(content.encode())
            stream.flush()
            os.fsync(stream.fileno())
            config = read_config(staging)
            staging.replace(home / "config.toml")
            return config
        finally:
            staging.unlink(missing_ok=True)


def running(home):
    if not home.is_dir() or not (home / "daemon.lock").is_file():
        return False
    try:
        with owner_lock(home, create=False):
            return False
    except FileNotFoundError:
        return False
    except BlockingIOError:
        return True


def diagnostics(root):
    from .codex import PATH

    home = home_for(root)
    configured = (home / "config.toml").is_file()
    return {"configured": configured, "core_running": running(home),
            "configuration": read_config(home / "config.toml") if configured else None,
            "migration_pending": (home / DESKTOP_TRANSFER).exists(),
            "codex_available": bool(shutil.which("codex", path=PATH)),
            "gh_available": bool(shutil.which("gh", path=PATH)),
            "project": str(root)}


async def bind_project(service, root, config):
    from .projects import identify

    path, identity = await identify(root)
    if path != root:
        raise ValueError("ADF はチェックアウトのルートに配置してください")
    store = service.store
    with store.db:
        rows = store.all("SELECT * FROM project")
        if rows and (len(rows) != 1 or rows[0]["path"] != str(root) or rows[0]["identity"] != identity):
            raise ValueError("状態 DB のプロジェクトがこのチェックアウトと一致しません")
        current = rows[0] if rows else None
        project = current["id"] if current else PROJECT
        if current and current["github"] and current["github"] != config["github"]:
            if store.one("SELECT id FROM session LIMIT 1") or store.one("SELECT id FROM tracker_operation LIMIT 1"):
                raise ValueError("研究履歴があるため GitHub リポジトリを変更できません")
        store.db.execute("INSERT INTO project(id,name,path,identity,github) VALUES (?,?,?,?,?) "
                         "ON CONFLICT(id) DO UPDATE SET name=excluded.name,github=excluded.github,archived=0",
                         (project, config["name"] or root.name, str(root), identity, config["github"]))
        preset = json.dumps(config["preset"], sort_keys=True)
        prior = store.one("SELECT value FROM local_setting WHERE name='config_preset'")
        action = "REPLACE" if prior and prior["value"] != preset else "IGNORE"
        store.db.execute(f"INSERT OR {action} INTO research_preset VALUES (?,?)", (project, preset))
        store.db.execute("INSERT OR REPLACE INTO local_setting VALUES ('config_preset',?)", (preset,))
        tracker = config.get("tracker")
        tracker_json = json.dumps(tracker, sort_keys=True)
        prior = store.one("SELECT value FROM local_setting WHERE name='config_tracker'")
        if tracker is not None and (not prior or prior["value"] != tracker_json):
            store.db.execute("INSERT OR REPLACE INTO tracker_policy VALUES (?,?)", (project, tracker_json))
        elif tracker is None and prior and prior["value"] != "null":
            store.db.execute("DELETE FROM tracker_policy WHERE project=?", (project,))
        store.db.execute("INSERT OR REPLACE INTO local_setting VALUES ('config_tracker',?)", (tracker_json,))
    service.local_project = project
    service.local_config = config
