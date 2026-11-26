"""SQLite checkpoint and event storage, written only by the ADF daemon."""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import time

ACTIVE = ("idle", "running", "waiting", "draining", "stopping", "quota")
DEFAULTS = {
    "coordinator": "Discuss ideas and research priorities with the user. Inspect project and issue "
                   "data as needed. Act as a read-only advisor. The user controls all lifecycle actions.",
    "developer": "Develop and verify the user's authorized work in the project. Respect repository "
                 "policy. Preserve existing changes. Record results and the next action.",
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL,
    identity TEXT NOT NULL, github TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS role (
    name TEXT PRIMARY KEY, instructions TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    effort TEXT NOT NULL DEFAULT '', recovery TEXT NOT NULL DEFAULT 'manual',
    budget INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES project(id),
    role TEXT NOT NULL REFERENCES role(name), state TEXT NOT NULL DEFAULT 'paused',
    generation INTEGER NOT NULL DEFAULT 0, thread TEXT UNIQUE, turn TEXT, last_turn TEXT,
    prompt TEXT NOT NULL DEFAULT '', allowed_template TEXT, revision TEXT, working TEXT, tokens INTEGER NOT NULL DEFAULT 0,
    turn_requests INTEGER NOT NULL DEFAULT 0, UNIQUE(project, role)
);
CREATE UNIQUE INDEX IF NOT EXISTS role_owner ON session(role)
    WHERE state IN ('idle','running','waiting','draining','stopping','quota');
CREATE TABLE IF NOT EXISTS template (
    project INTEGER NOT NULL REFERENCES project(id), name TEXT NOT NULL, argv TEXT NOT NULL,
    timeout INTEGER NOT NULL, PRIMARY KEY(project, name)
);
CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY, session INTEGER NOT NULL REFERENCES session(id), generation INTEGER NOT NULL,
    call TEXT NOT NULL, turn TEXT NOT NULL, revision TEXT NOT NULL, name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running', exit_code INTEGER, wake TEXT NOT NULL DEFAULT 'pending',
    started REAL NOT NULL, finished REAL, initial_requests INTEGER NOT NULL,
    initial_tokens INTEGER NOT NULL, waiting_since REAL, waiting_requests INTEGER, waiting_tokens INTEGER,
    UNIQUE(session, turn), UNIQUE(session, call)
);

CREATE TABLE IF NOT EXISTS research_task (
    id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES project(id),
    title TEXT NOT NULL, criteria TEXT NOT NULL, priority INTEGER NOT NULL,
    dependencies TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', result TEXT,
    UNIQUE(project, title)
);
CREATE TABLE IF NOT EXISTS research_run (
    session INTEGER PRIMARY KEY REFERENCES session(id), generation INTEGER NOT NULL,
    scope TEXT NOT NULL, task INTEGER REFERENCES research_task(id), state TEXT NOT NULL,
    job_limit INTEGER NOT NULL, timeout INTEGER NOT NULL, turn_limit INTEGER NOT NULL,
    token_limit INTEGER NOT NULL, start_turns INTEGER NOT NULL, start_tokens INTEGER NOT NULL,
    jobs INTEGER NOT NULL DEFAULT 0, decision_turn TEXT, decision TEXT
);
CREATE TABLE IF NOT EXISTS research_experiment (
    job TEXT PRIMARY KEY REFERENCES job(id), task INTEGER NOT NULL REFERENCES research_task(id),
    program TEXT NOT NULL, timeout INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_import (
    project INTEGER NOT NULL REFERENCES project(id), fingerprint TEXT NOT NULL, path TEXT NOT NULL,
    PRIMARY KEY(project, fingerprint)
);
CREATE TABLE IF NOT EXISTS tracker_policy (
    project INTEGER PRIMARY KEY REFERENCES project(id), operations TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracker_operation (
    id TEXT PRIMARY KEY, project INTEGER NOT NULL REFERENCES project(id), repository TEXT NOT NULL,
    kind TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS github_task (
    project INTEGER NOT NULL REFERENCES project(id), repository TEXT NOT NULL, number INTEGER NOT NULL,
    task INTEGER NOT NULL UNIQUE REFERENCES research_task(id), PRIMARY KEY(project, repository, number)
);
CREATE TABLE IF NOT EXISTS github_run (
    session INTEGER PRIMARY KEY REFERENCES session(id), generation INTEGER NOT NULL,
    repository TEXT NOT NULL, issue INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    operation TEXT REFERENCES tracker_operation(id), phase TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracker_guard (
    operation TEXT PRIMARY KEY REFERENCES tracker_operation(id), session INTEGER NOT NULL REFERENCES session(id),
    generation INTEGER NOT NULL, fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracker_expectation (
    operation TEXT PRIMARY KEY REFERENCES tracker_operation(id), fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_usage (
    session INTEGER NOT NULL REFERENCES session(id), thread TEXT NOT NULL, turn TEXT NOT NULL, sequence INTEGER,
    task INTEGER, job TEXT, quota TEXT, total TEXT, last TEXT, initial INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session,turn)
);
CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session INTEGER REFERENCES session(id),
    time REAL NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
);
"""


def default_home():
    return Path.home() / "Library/Application Support/ADF"


def private_dir(path):
    path = path.absolute()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    stat = path.lstat()
    if path.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise ValueError("ADF の状態ディレクトリには所有者専用の権限 (0700) が必要です")
    return path.resolve()


@contextlib.contextmanager
def owner_lock(home):
    with (home / "daemon.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield lock


class Store:
    def __init__(self, home):
        self.home = home
        self.db = sqlite3.connect(home / "state.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = FULL")
        self.db.executescript(SCHEMA)
        with self.db:
            columns = {row["name"] for row in self.all("PRAGMA table_info(session)")}
            for column in ("thread_tools", "token_floor"):
                if column not in columns:
                    self.db.execute(f"ALTER TABLE session ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            self.db.executemany("INSERT OR IGNORE INTO role(name) VALUES (?)", [(role,) for role in DEFAULTS])

    def recover(self):
        placeholders = ",".join("?" for _ in ACTIVE)
        with self.db:
            for row in self.all(f"SELECT id FROM session WHERE state IN ({placeholders})", ACTIVE):
                self.event(row["id"], "recovered", "前回の監督が終了しました。作業状態を確認して再開してください")
            self.db.execute(f"UPDATE session SET state='interrupted', generation=generation+1, turn=NULL "
                            f"WHERE state IN ({placeholders})", ACTIVE)
            self.db.execute("UPDATE job SET state='interrupted', finished=? WHERE state='running'", (time.time(),))
            self.db.execute("UPDATE job SET wake='suppressed' WHERE wake IN ('pending','claimed')")

    def expire_tracker_approvals(self, session=None):
        self.db.execute(
            "UPDATE tracker_operation SET state='expired' WHERE state='pending' AND id IN ("
            "SELECT g.operation FROM tracker_guard g JOIN session s ON s.id=g.session "
            "WHERE g.generation<>s.generation AND (? IS NULL OR s.id=?))", (session, session))

    def one(self, sql, args=()):
        row = self.db.execute(sql, args).fetchone()
        return dict(row) if row else None

    def all(self, sql, args=()):
        return [dict(row) for row in self.db.execute(sql, args)]

    def session(self, session):
        return self.one("SELECT session.*,project.path,project.identity FROM session "
                        "JOIN project ON project.id=session.project WHERE session.id=?", (session,))

    def update_session(self, session, **fields):
        # All field names come from code, never from a client payload.
        columns = ",".join(f"{name}=?" for name in fields)
        self.db.execute(f"UPDATE session SET {columns} WHERE id=?", (*fields.values(), session))

    def event(self, session, kind, detail):
        self.db.execute("INSERT INTO event(session,time,kind,detail) VALUES (?,?,?,?)",
                        (session, time.time(), kind, json.dumps(detail, ensure_ascii=False)))
