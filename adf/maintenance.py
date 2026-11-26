"""Offline operator maintenance. The daemon and maintenance share an exclusive lease."""

import asyncio
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile

from .ipc_support import atomic_json
from .legacy import confirm_idle, inventory, legacy_lease
from .local import read_config
from .projects import git, identify
from .store import ACTIVE, DESKTOP_TRANSFER, desktop_home, owner_lock, private_dir


def tree_stamp(path, ignored=()):
    items = []
    if path.exists():
        for parent, dirs, files in os.walk(path, followlinks=False):
            dirs[:] = sorted(name for name in dirs if name not in ignored)
            for name in sorted(set(dirs + files) - set(ignored)):
                item = Path(parent) / name
                info = item.lstat()
                items.append((str(item.relative_to(path)), info.st_mode, info.st_size, info.st_mtime_ns,
                              os.readlink(item) if item.is_symlink() else None))
    return items


def clone_tree(source, target):
    if source.is_symlink() or not source.is_dir():
        raise ValueError("移行元または成果物のディレクトリが不正です")
    def ignore_special(parent, names):
        return [name for name in names if not (
            stat.S_ISREG(mode := (Path(parent) / name).lstat().st_mode)
            or stat.S_ISDIR(mode) or stat.S_ISLNK(mode))]
    shutil.copytree(source, target, symlinks=True, ignore=ignore_special)


@contextmanager
def database(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("移行元の SQLite がありません")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA trusted_schema=OFF")
        yield db


def check_db(db):
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute(
            "PRAGMA foreign_key_check").fetchone():
        raise ValueError("SQLite の整合性検査に失敗しました")


def desktop_inventory(source, root):
    with database(source / "state.sqlite3") as db:
        rows = db.execute("SELECT * FROM project WHERE path=?", (str(root),)).fetchall()
        if len(rows) != 1:
            raise ValueError("このチェックアウトに一致する Desktop プロジェクトがありません")
        project = dict(rows[0])
        assigned = db.execute("SELECT role,state,thread FROM session WHERE project=?", (project["id"],))
        sessions = [dict(row) for row in assigned]
        jobs = [dict(row) for row in db.execute(
            "SELECT job.id,job.state FROM job JOIN session ON session.id=job.session WHERE project=?",
            (project["id"],))]
        operations = db.execute("SELECT count(*) FROM tracker_operation WHERE project=? AND state='sending'",
                                (project["id"],)).fetchone()[0]
    return {"project": project, "sessions": sessions, "jobs": jobs,
            "unknown_github_operations": operations}


def clone_database(source, target):
    with database(source) as old, closing(sqlite3.connect(target)) as new:
        old.backup(new)
        new.execute("PRAGMA trusted_schema=OFF")
        check_db(new)


def restrict_desktop(path, project):
    # Remove non-project records before publishing the migrated database.
    # The source schema has no cascade rules so each dependent set is explicit.
    by_session = ("job", "research_run", "github_run", "turn_usage", "tracker_guard", "event", "conversation")
    by_project = ("research_preset", "template", "research_task", "legacy_import", "tracker_policy",
                  "tracker_operation", "github_task")
    with closing(sqlite3.connect(path)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        with db:
            db.execute("DELETE FROM research_experiment WHERE job NOT IN "
                       "(SELECT job.id FROM job JOIN session ON session.id=job.session WHERE project=?)", (project,))
            if "tracker_expectation" in tables:
                db.execute("DELETE FROM tracker_expectation WHERE operation NOT IN "
                           "(SELECT id FROM tracker_operation WHERE project=?)", (project,))
            for table in by_session:
                if table in tables:
                    db.execute(f"DELETE FROM {table} WHERE session IS NULL OR session NOT IN "
                               "(SELECT id FROM session WHERE project=?)", (project,))
            for table in (*by_project, "session"):
                if table in tables:
                    db.execute(f"DELETE FROM {table} WHERE project<>?", (project,))
            db.execute("DELETE FROM project WHERE id<>?", (project,))
            db.execute("UPDATE project SET archived=0 WHERE id=?", (project,))
            db.execute("UPDATE tracker_operation SET state='expired' WHERE state='pending'")
            db.execute("UPDATE job SET wake='suppressed' WHERE wake IN ('claimed','pending')")
        check_db(db)
        db.execute("VACUUM")
        db.execute("PRAGMA journal_mode=DELETE")


def backup(home):
    target = private_dir(home / "backups")
    staging = Path(tempfile.mkdtemp(prefix=".backup-", dir=target))
    destination = target / staging.name.removeprefix(".")
    try:
        for name in ("jobs", "migration"):
            if (home / name).exists():
                clone_tree(home / name, staging / name)
        for name in ("config.toml", "state.sqlite3", "supervisor.log"):
            source = home / name
            if source.exists():
                if name == "state.sqlite3":
                    clone_database(source, staging / name)
                else:
                    if source.is_symlink() or not source.is_file():
                        raise ValueError("保全対象のファイルが不正です")
                    if name == "config.toml":
                        read_config(source)
                    shutil.copy2(source, staging / name, follow_symlinks=False)
        staging.rename(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {"backup": str(destination)}


def preview(root, source, kind):
    if kind == "desktop":
        info = desktop_inventory(source, root)
        metadata = tree_stamp(source, {"ipc", "daemon.lock", "state.sqlite3-shm"})
        conflicts = [row["role"] for row in info["sessions"] if row["state"] in ACTIVE]
        conflicts += [job["id"] for job in info["jobs"] if job["state"] == "running"]
    else:
        info = inventory(root, runtime=source)
        metadata = tree_stamp(source, {"state.lock", "adf.sqlite3-shm"})
        try:
            confirm_idle(info)
            conflicts = []
        except ValueError as error:
            conflicts = [str(error)]
    digest = hashlib.sha256(json.dumps([info, metadata], sort_keys=True).encode()).hexdigest()
    return {**info, "kind": kind, "source": str(source), "conflicts": conflicts, "fingerprint": digest}


def load_desktop(home, source, report, root, staged):
    for entry in ("state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm", "jobs"):
        path = home / entry
        if path.exists() or path.is_symlink():
            raise ValueError("移行先に DB または実験が存在します。既存の状態を保全してください")
    if (home / "config.toml").exists():
        config = read_config(home / "config.toml")
        if report["project"]["github"] != config["github"]:
            raise ValueError("Desktop と移行先で GitHub リポジトリが異なります")
    _, identity = asyncio.run(identify(root))
    if report["project"]["identity"] != identity:
        raise ValueError("Desktop が記録した Git の実体と一致しません")
    clone_database(source / "state.sqlite3", staged / "state.sqlite3")
    restrict_desktop(staged / "state.sqlite3", report["project"]["id"])
    jobs = staged / "jobs"
    jobs.mkdir(mode=0o700)
    for job in report["jobs"]:
        identifier = job["id"]
        if not isinstance(identifier, str) or Path(identifier).name != identifier or identifier in (".", ".."):
            raise ValueError("Desktop の実験 ID が不正です")
        origin = source / "jobs" / identifier
        if origin.exists():
            if origin.parent.is_symlink():
                raise ValueError("Desktop の実験ディレクトリが不正です")
            clone_tree(origin, jobs / identifier)


def finish_desktop_transfer(home, archive, target, fingerprint):
    journal = home / DESKTOP_TRANSFER
    record = json.loads(journal.read_text(encoding="utf-8"))
    name = record.get("staging", "")
    if (record.get("fingerprint") != fingerprint or Path(name).name != name
            or not name.startswith(".migration-")):
        raise ValueError("保留中の Desktop 移行と同じ fingerprint で再実行してください")
    staging = archive / name
    if staging.exists():
        if target.exists():
            raise ValueError("移行の保全先が競合しています")
        staging.rename(target)
    report = json.loads((target / "report.json").read_text(encoding="utf-8"))
    if report.get("fingerprint") != fingerprint:
        raise ValueError("Desktop 移行の保全情報を確認してください")
    for entry in ("jobs", "state.sqlite3"):
        pending, installed = target / entry, home / entry
        if pending.is_symlink() or installed.is_symlink() or pending.exists() == installed.exists():
            raise ValueError(f"Desktop 移行の配置を確認してください: {entry}")
        if pending.exists():
            pending.rename(installed)
    with database(home / "state.sqlite3") as db:
        check_db(db)
    journal.unlink()
    return {"archive": str(target), "jobs": len(report["jobs"]), "mode": "desktop"}


def migrate(root, home, kind, source, fingerprint):
    default = desktop_home() if kind == "desktop" else root / "agents/runtime"
    source = (source or default).expanduser().absolute()
    if source.is_symlink() or not source.is_dir():
        raise ValueError("移行元のディレクトリがありません")
    source = source.resolve()
    if source.is_relative_to(home) or home.is_relative_to(source):
        raise ValueError("移行元と移行先は別のディレクトリを指定してください")
    if fingerprint is None:
        if (home / DESKTOP_TRANSFER).is_file():
            pending = json.loads((home / DESKTOP_TRANSFER).read_text(encoding="utf-8"))
            return {"destination_pending": True, "fingerprint": pending["fingerprint"]}
        result = preview(root, source, kind)
        result["destination_running"] = (home / "daemon.lock").is_file() and _locked(home)
        result["source_running"] = kind == "desktop" and (source / "daemon.lock").is_file() and _locked(source)
        result["destination_conflict"] = kind == "desktop" and any(
            (home / entry).exists() for entry in ("state.sqlite3", "jobs"))
        return result
    if len(fingerprint) != 64 or any(char not in "0123456789abcdef" for char in fingerprint):
        raise ValueError("プレビューで表示された fingerprint を指定してください")
    home = private_dir(home)
    with owner_lock(home):
        archive = private_dir(home / "migration")
        target = archive / f"{kind}-{fingerprint}"
        journal = home / DESKTOP_TRANSFER
        if journal.exists():
            if kind != "desktop":
                raise ValueError("保留中の Desktop 移行を完了してください")
            return finish_desktop_transfer(home, archive, target, fingerprint)
        if (target / "report.json").is_file():
            return {"already_imported": True, "archive": str(target)}
        lease = (owner_lock(source, create=False) if kind == "desktop" else
                 legacy_lease(root, runtime=source))
        with lease:
            report = preview(root, source, kind)
            if report["conflicts"] or report["fingerprint"] != fingerprint:
                raise ValueError("移行元が稼働中かプレビュー後に変わりました。停止して再確認してください")
            stage = Path(tempfile.mkdtemp(prefix=".migration-", dir=archive))
            try:
                if kind == "desktop":
                    load_desktop(home, source, report, root, stage)
                else:
                    clone_tree(source, stage / "legacy-runtime")
                    for name in ("agents/config.toml", "agents/research/state.json"):
                        original = root / name
                        if original.is_file() and not original.is_symlink():
                            shutil.copy2(original, stage / original.name)
                (stage / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                if kind == "desktop":
                    shutil.copy2(stage / "state.sqlite3", stage / "desktop-backup.sqlite3")
                    atomic_json(journal, {"fingerprint": fingerprint, "staging": stage.name})
                    return finish_desktop_transfer(home, archive, target, fingerprint)
                stage.rename(target)
            finally:
                if stage.exists() and not journal.exists():
                    shutil.rmtree(stage)
        return {"archive": str(target), "jobs": len(report["jobs"]), "mode": kind}


def _locked(home):
    from .local import running
    return running(home)


def maintain(root, home, action, args):
    if action == "migrate":
        return migrate(root, home, args["kind"], args["source"], args["apply"])
    read_config(home / "config.toml")
    with owner_lock(private_dir(home)):
        if (home / DESKTOP_TRANSFER).exists():
            raise ValueError("保留中の Desktop 移行を完了してください")
        result = backup(home)
        if action == "update":
            revision = asyncio.run(git(root, "rev-parse", "HEAD")).decode().strip()
            result.update(revision=revision, update_mode="manual")
        return result
