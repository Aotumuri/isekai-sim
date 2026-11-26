"""Capture only explicitly approved worktree paths and offline dependencies."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat

from .ipc_support import atomic_json

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
MAX_OVERLAY = 16 * 1024**2
MAX_DEPENDENCIES = 256 * 1024**2


def relative(text):
    if not isinstance(text, str) or "\0" in text or "\\" in text or len(text) > 400:
        raise ValueError("作業ツリー内の相対パスを指定してください")
    path = PurePosixPath(text)
    if path.is_absolute() or not path.parts or any(
            p.lower() in {"..", ".git", ".codex", ".agents", ".aws", ".adf-artifacts", ".adf-site", ".adf-node"}
            or p.lower().startswith(".env") for p in path.parts):
        raise ValueError("保護対象または無効なパスです")
    return path


def options(runtime, files, dependencies, evidence):
    if runtime not in ("python", "node") or not isinstance(files, list) or len(files) > 30:
        raise ValueError("実験ランタイムと承認するファイルを確認してください")
    files = sorted(set(str(relative(name)) for name in files))
    dependencies = str(relative(dependencies)) if dependencies else ""
    evidence = sorted(set(str(relative(name)) for name in evidence)) if isinstance(evidence, list) else None
    if evidence is None or len(evidence) > 20:
        raise ValueError("必須成果物は20個以内です")
    return {"runtime": runtime, "files": files, "dependencies": dependencies, "artifacts": evidence}


def directory(root, parts=()):
    fd = os.open(root, DIR)
    try:
        for part in parts:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def regular(fd, name, limit):
    with os.fdopen(os.open(name, FILE, dir_fd=fd), "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError("実験入力は上限内の通常ファイルに限ります")
        data = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
        if len(data) != before.st_size or len(data) > limit or before.st_mtime_ns != after.st_mtime_ns:
            raise ValueError("読み取り中に実験入力が変更されました")
        return data, before.st_mode & stat.S_IXUSR


def capture(root, files):
    captured = {}
    total = 0
    for name in files:
        path = relative(name)
        try:
            fd = directory(root, path.parts[:-1])
            try:
                data, mode = regular(fd, path.name, MAX_OVERLAY - total)
            finally:
                os.close(fd)
        except FileNotFoundError:
            captured[name] = None
            continue
        total += len(data)
        captured[name] = (data, mode)
    return captured


def hashes(captured):
    return {name: None if item is None else {"sha256": hashlib.sha256(item[0]).hexdigest(),
                                             "executable": bool(item[1])} for name, item in captured.items()}


def write_capture(root, captured, *, delete=False):
    for name, item in captured.items():
        target = root / name
        if item is None:
            if delete:
                target.unlink(missing_ok=True)
            continue
        data, mode = item
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o600 | mode)


def metadata(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode]


def scan_dependencies(root, dependency, visitor=None):
    fd = directory(root, relative(dependency).parts)
    entries = {}
    remaining = MAX_DEPENDENCIES

    def walk(parent, prefix, depth):
        nonlocal remaining
        if depth > 32:
            raise ValueError("依存ディレクトリが深すぎます")
        with os.scandir(parent) as items:
            for item in items:
                if item.name in {".bin", "__pycache__", ".cache"}:
                    continue
                name = str(prefix / item.name)
                relative(name)
                info = item.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(item.name, DIR, dir_fd=parent)
                    try:
                        walk(child, prefix / item.name, depth + 1)
                    finally:
                        os.close(child)
                    continue
                if (len(entries) >= 20000 or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or info.st_size > remaining):
                    raise ValueError("依存ファイル数・容量の上限を超えたか、通常ファイル以外が含まれます")
                if visitor:
                    data, mode = regular(parent, item.name, remaining)
                    after = os.stat(item.name, dir_fd=parent, follow_symlinks=False)
                    if metadata(info) != metadata(after):
                        raise ValueError("コピー中に依存ファイルが変更されました")
                    visitor(name, data, mode)
                remaining -= info.st_size
                entries[name] = metadata(info)

    try:
        walk(fd, PurePosixPath(), 0)
    finally:
        os.close(fd)
    raw = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def copy_dependencies(root, dependency, target):
    entries = {}
    target.mkdir(parents=True, mode=0o700)

    def save(name, data, mode):
        write_capture(target, {name: (data, mode)})
        entries.update(hashes({name: (data, mode)}))

    stamp = scan_dependencies(root, dependency, save)
    return entries, stamp


def prepare_inputs(source, project, plan, captured, revision, environment, conditions=None):
    staging = source.parent / "input"
    staging.mkdir(mode=0o700, exist_ok=True)
    write_capture(staging / "overlay", captured)
    write_capture(source, captured, delete=True)
    dependencies, dependency_stamp = {}, None
    if plan["dependencies"]:
        target = "node_modules" if plan["runtime"] == "node" else ".adf-site"
        if (source / target).exists():
            raise ValueError("コミット済みの依存ディレクトリと衝突しています")
        dependencies, dependency_stamp = copy_dependencies(project, plan["dependencies"], staging / target)
        if scan_dependencies(project, plan["dependencies"]) != dependency_stamp:
            raise ValueError("コピー中に依存ディレクトリが変更されました")
        shutil.copytree(staging / target, source / target)
    manifest = {"revision": revision, "overlay": hashes(captured), "dependencies": dependencies,
                "dependency_source": plan["dependencies"], "dependency_stamp": dependency_stamp,
                "runtime": environment, "conditions": conditions}
    atomic_json(staging / "manifest.json", manifest)
    return manifest
