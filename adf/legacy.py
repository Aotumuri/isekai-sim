"""Read-only legacy inventory and shared exclusion with legacy Developer."""

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tomllib

from .artifacts import read_result
from .ipc_support import atomic_json
from .store import ACTIVE

FILES = ("control.json", "developer.json", "github-checkpoint.json")
ACTIVE_JOBS = {"queued", "running"}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def bounded_source(root, path):
    try:
        page = read_result(root, path, size=65536)
    except FileNotFoundError:
        return None
    if page["next"] != page["total"]:
        raise ValueError(f"旧 ADF の {path} が検査上限を超えています")
    return page["text"]


def legacy_runtime(root):
    return root / "agents/runtime"


def inventory(root, *, runtime=None):
    runtime = runtime or legacy_runtime(root)
    if not (root / "agents").is_dir():
        return {"format": "none", "owner": None, "control": None, "checkpoint": None, "jobs": []}
    for directory in (root / "agents", runtime, runtime / "jobs"):
        if directory.is_symlink():
            raise ValueError("旧 ADF の状態ディレクトリにシンボリックリンクが含まれます")

    records = {name: json.loads(value) for name in FILES if (value := bounded_source(runtime, name)) is not None}
    owner = (records.get("developer.json") or {}).get("id")
    control = records.get("control.json")
    job_rows = {}
    database = runtime / "adf.sqlite3"
    sqlite_present = database.exists() or database.is_symlink()
    if sqlite_present:
        if not stat.S_ISREG(database.lstat().st_mode):
            raise ValueError("旧 ADF の SQLite ファイルを検査できません")
        with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as connection:
            connection.execute("BEGIN")
            rows = connection.execute("SELECT owner FROM developers WHERE id=1").fetchone()
            if rows and rows[0]:
                owner = rows[0]
            row = connection.execute("SELECT state_json FROM lifecycle WHERE id=1").fetchone()
            if row:
                control = json.loads(row[0])
            for job, state, revision in connection.execute("SELECT job_id,status,revision FROM jobs LIMIT 1001"):
                job_rows[job] = {"id": job, "state": state, "revision": revision}
            if len(job_rows) > 1000:
                raise ValueError("旧 ADF の実験履歴が検査上限を超えています")
    if (runtime / "jobs").is_dir():
        with os.scandir(runtime / "jobs") as entries:
            for index, entry in enumerate(entries):
                if index >= 1000:
                    raise ValueError("旧 ADF の実験履歴が検査上限を超えています")
                if not entry.is_dir(follow_symlinks=False):
                    continue
                if (raw := bounded_source(Path(entry.path), "manifest.json")) is not None:
                    manifest = json.loads(raw)
                    state = manifest.get("status")
                    prior = job_rows.get(entry.name, {})
                    if state in ACTIVE_JOBS or prior.get("state") not in ACTIVE_JOBS:
                        job_rows[entry.name] = {"id": entry.name, "state": state, "revision": manifest.get("revision")}
    settings = bounded_source(root / "agents", "config.toml")
    config = tomllib.loads(settings) if settings else {}
    tracker = config.get("tracker", {})
    return {"format": "sqlite" if sqlite_present else "json" if records or config else "none",
            "owner": owner, "control": control, "checkpoint": records.get("github-checkpoint.json"),
            "jobs": sorted(job_rows.values(), key=lambda job: job["id"]),
            "tracker": {"backend": tracker.get("backend"), "repository": tracker.get("github", {}).get("repository")},
            "role_files": [f"agents/docs/roles/{role}.md" for role in ("developer", "coordinator")
                           if (root / f"agents/docs/roles/{role}.md").is_file()]}


def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def confirm_idle(data):
    control = data.get("control") or {}
    if data["owner"]:
        raise ValueError("旧 ADF の Developer を停止し、所有権を解放してください")
    if control.get("mode") == "stopping":
        raise ValueError("旧 ADF は停止処理中です。停止を完了してください")
    if any(job["state"] in ACTIVE_JOBS for job in data["jobs"]):
        raise ValueError("旧 ADF に実行待ちまたは実行中の実験があります。実験の終了を確認してください")


@contextlib.contextmanager
def legacy_lease(root, *, runtime=None):
    runtime = runtime or legacy_runtime(root)
    agents = runtime.parent
    if not (runtime.exists() or (agents / "tools/research.py").is_file()):
        yield
        return
    agents_fd = os.open(agents, DIR_FLAGS)
    try:
        try:
            os.mkdir(runtime.name, mode=0o700, dir_fd=agents_fd)
        except FileExistsError:
            pass
        runtime_fd = os.open(runtime.name, DIR_FLAGS, dir_fd=agents_fd)
        try:
            lock = os.open("state.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                           0o600, dir_fd=runtime_fd)
        finally:
            os.close(runtime_fd)
    finally:
        os.close(agents_fd)
    with os.fdopen(lock, "r+b") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("旧 ADF のロックファイルが不正です")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("旧 ADF または別の Desktop が共有ロックを保持しています") from None
        confirm_idle(inventory(root, runtime=runtime))
        yield


class Legacy:
    def legacy_preview(self, project):
        data = inventory(Path(self.project(project)["path"]))
        return {"digest": digest(data), **data}

    def legacy_import(self, project, fingerprint):
        row = self.project(project)
        developer = self.session_for(project, "developer")
        if developer and developer["state"] in ACTIVE:
            raise ValueError("Desktop の Developer を停止してから移行してください")
        root = Path(row["path"])
        with legacy_lease(root):
            data = inventory(root)
            if data["format"] == "none" or digest(data) != fingerprint:
                raise ValueError("保存できる旧 ADF の状態がないか、プレビュー後に変更されました")
            target = self.store.home / "migration" / f"{project}-{fingerprint}.json"
            target.parent.mkdir(mode=0o700, exist_ok=True)
            atomic_json(target, data)
            if digest(json.loads(target.read_text())) != fingerprint:
                raise ValueError("移行用スナップショットの整合性検証に失敗しました")
            with self.store.db:
                self.store.db.execute("INSERT OR IGNORE INTO legacy_import VALUES (?,?,?)",
                                      (project, fingerprint, str(target)))
        return {"digest": fingerprint, "jobs": len(data["jobs"]), "mode": "archived"}
