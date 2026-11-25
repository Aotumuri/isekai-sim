"""Git project identity and detached experiment snapshots."""

import asyncio
import json
import os
from pathlib import Path
import re
import stat

from .codex import environment

GIT = "/usr/bin/git"


async def git(path, *args, stdout=asyncio.subprocess.PIPE):
    env = {**environment(), "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0",
           "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1"}
    process = await asyncio.create_subprocess_exec(
        GIT, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
        "-C", str(path), *args, env=env, stdout=stdout, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(process.communicate(), 30)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode:
        raise ValueError(f"Git の {args[0]} に失敗しました")
    return out


async def identify(path):
    root = Path((await git(path, "rev-parse", "--show-toplevel")).decode().strip()).resolve(strict=True)
    common = Path((await git(root, "rev-parse", "--path-format=absolute",
                             "--git-common-dir")).decode().strip()).resolve(strict=True)
    stat = common.stat()
    work = root.stat()
    return root, f"{stat.st_dev}:{stat.st_ino}:{work.st_dev}:{work.st_ino}"


async def checkpoint(project):
    path, key = await identify(project["path"])
    if str(path) != project["path"] or key != project["identity"]:
        raise ValueError("プロジェクトの場所または Git の実体が登録時と異なります")
    revision = (await git(path, "rev-parse", "--verify", "HEAD^{commit}")).decode().strip()
    index = Path((await git(path, "rev-parse", "--path-format=absolute",
                            "--git-path", "index")).decode().strip())
    return revision, str(index.stat().st_mtime_ns) if index.exists() else ""


async def snapshot(path, revision, job):
    listing = await git(path, "ls-tree", "-r", "-l", "-z", revision)
    entries = []
    total = 0
    source = job / "source"
    source.mkdir(mode=0o700, parents=True)
    for record in listing.split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, kind, oid, size = metadata.split()
        target = Path(os.fsdecode(name))
        if (target.is_absolute() or not target.parts
                or any(part.lower() in {".", "..", ".git"} for part in target.parts)):
            raise ValueError("Unsafe snapshot path")
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError("Snapshots currently support regular tracked files only")
        total += int(size)
        if total > 128 * 1024**2 or len(entries) >= 10000:
            raise ValueError("Snapshot exceeds size limit")
        entries.append((mode, oid, target))
    await materialize(path, source, entries)
    return source


async def materialize(path, source, entries):
    env = {**environment(), "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1",
           "GIT_TERMINAL_PROMPT": "0"}
    process = await asyncio.create_subprocess_exec(
        GIT, "-C", str(path), "cat-file", "--batch", env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        async with asyncio.timeout(60):
            for mode, oid, relative in entries:
                process.stdin.write(oid + b"\n")
                await process.stdin.drain()
                header = (await process.stdout.readline()).split()
                if len(header) != 3 or header[:2] != [oid, b"blob"]:
                    raise ValueError("Missing Git blob")
                content = await process.stdout.readexactly(int(header[2]))
                if await process.stdout.readexactly(1) != b"\n":
                    raise ValueError("Invalid Git blob stream")
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as handle:
                    handle.write(content)
                if mode == b"100755":
                    target.chmod(target.stat().st_mode | stat.S_IXUSR)
            process.stdin.close()
            await process.wait()
            if process.returncode:
                raise ValueError("Git blob snapshot failed")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def clean_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", name):
        raise ValueError("識別名は英小文字から始め、英小文字・数字・_・- を40文字以内で指定してください")
    return name


async def issues(repository):
    if not repository:
        return []
    process = await asyncio.create_subprocess_exec(
        "gh", "issue", "list", "--repo", repository, "--state", "all", "--limit", "50",
        "--json", "number,title,state,url", stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=environment())
    try:
        out, _ = await asyncio.wait_for(process.communicate(), 20)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode:
        raise ValueError("GitHub Issues を取得できません。gh の認証と接続を確認してください")
    return json.loads(out)
