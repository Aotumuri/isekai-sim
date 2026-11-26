"""Read Git evidence for a research task and prepare its human handoff."""

import difflib
import json
import os
import re

from .projects import checkpoint, git
from .snapshots import capture, hashes


COMMIT_SUBJECT = re.compile(r"[a-z][a-z0-9-]*\([a-zA-Z0-9][a-zA-Z0-9_./-]*\)!?: \S.*")


def git_paths(output):
    return {os.fsdecode(name) for name in output.split(b"\0") if name}


async def committed_file(root, revision, name):
    listing = await git(root, "--literal-pathspecs", "ls-tree", "-l", "-z", revision, "--", name)
    if not listing:
        return None
    meta, _ = listing.rstrip(b"\0").split(b"\t", 1)
    mode, kind, oid, size = meta.split()
    if kind != b"blob" or mode not in (b"100644", b"100755") or int(size) > 1024**2:
        raise ValueError("変更確認では1 MiB以下の通常ファイルを対象にしてください")
    data = await git(root, "cat-file", "blob", oid.decode("ascii"))
    return data, 0o100 if mode == b"100755" else 0


def patch(name, before, after):
    try:
        left = before[0].decode("utf-8").splitlines(keepends=True) if before else []
        right = after[0].decode("utf-8").splitlines(keepends=True) if after else []
    except UnicodeError:
        return "バイナリファイル。内容は通常の Git クライアントで確認してください。"
    mode = ""
    if before and after and before[1] != after[1]:
        mode = f"実行ビット: {bool(before[1])} → {bool(after[1])}\n"
    return mode + "".join(difflib.unified_diff(left, right, f"a/{name}", f"b/{name}"))


class GitReview:
    async def pin_commit_base(self, row, run, revision):
        scope = json.loads(run["scope"])
        plan = scope.get("experiment") or {}
        if "commit_base" in scope and (not plan.get("require_commit") or scope.get("commit_task") == run["task"]):
            return
        if plan.get("require_commit"):
            plan["baseline"] = hashes(capture(row["path"], plan["files"]))
            scope["commit_task"] = run["task"]
            scope["prior_staged"] = sorted(git_paths(await git(
                row["path"], "diff", "--cached", "--name-only", "--no-renames", "-z", revision, "--"
            )).intersection(plan["files"]))
            if not self.visible(row["id"], row["generation"], ("running",)):
                return
        scope["commit_base"] = revision
        with self.store.db:
            self.store.db.execute("UPDATE research_run SET scope=? WHERE session=?",
                                  (json.dumps(scope), row["id"]))

    async def verified_commit(self, row, scope, expected=None):
        base = scope.get("commit_base")
        plan = scope["experiment"]
        root = row["path"]
        revision, _ = await checkpoint(row)
        if not base or (expected and revision != expected):
            raise ValueError("The task's recorded commit is unavailable or HEAD changed.")
        if revision == base:
            raise ValueError("HEAD has no commit for this task.")
        parents = (await git(root, "rev-list", "--parents", "-n", "1", revision)).decode().split()
        if parents != [revision, base]:
            raise ValueError("HEAD must be one commit directly after the task's starting revision.")
        subject = (await git(root, "show", "-s", "--format=%s", revision)).decode(errors="replace").strip()
        if not COMMIT_SUBJECT.fullmatch(subject):
            raise ValueError("The commit needs a scoped Conventional Commit subject.")
        changed = git_paths(await git(root, "diff", "--name-only", "--no-renames", "-z", base, revision, "--"))
        if not changed or not changed.issubset(plan["files"]) or changed.intersection(scope["prior_staged"]):
            raise ValueError("The commit has no approved changes, includes unrelated paths, or includes prior staging.")
        current = capture(root, plan["files"])
        for name, value in current.items():
            if name in changed:
                before = await committed_file(root, base, name)
                if hashes({name: before})[name] != plan["baseline"][name]:
                    raise ValueError("The commit includes a path with pre-existing worktree changes.")
            if value != await committed_file(root, revision, name):
                raise ValueError("An approved worktree file differs from the commit.")
        return {"revision": revision, "files": sorted(changed)}

    async def commit_preview(self, project):
        row = self.session_for(project, "developer")
        if not row or row["state"] not in ("paused", "interrupted"):
            raise ValueError("変更を確認する前に Developer を停止してください")
        run = self.store.one("SELECT scope FROM research_run WHERE session=?", (row["id"],))
        scope = json.loads(run["scope"]) if run else {}
        plan = scope.get("experiment", {})
        revision, _ = await checkpoint(self.store.session(row["id"]))
        if not scope.get("commit_base") or scope["commit_base"] != revision or not plan.get("files"):
            raise ValueError("承認ファイルと研究開始時の HEAD が一致する状態で確認してください")
        root = self.project(project)["path"]
        current = capture(root, plan["files"])
        candidates = []
        before_run = []
        budget = 128 * 1024
        for name, after in current.items():
            before = await committed_file(root, revision, name)
            if name in scope.get("prior_staged", ()) or hashes({name: before})[name] != plan["baseline"][name]:
                before_run.append(name)
            elif before != after:
                diff = patch(name, before, after)
                shown = diff.encode()[:budget].decode(errors="ignore")
                budget -= len(shown.encode())
                candidates.append({"path": name, "patch": shown, "truncated": shown != diff,
                                   "before": hashes({name: before})[name], "after": hashes({name: after})[name]})
        if not self.visible(row["id"], row["generation"], ("paused", "interrupted")):
            raise ValueError("確認中に Developer の状態が変わりました")
        return {"base": revision, "files": candidates, "excluded_prior_changes": before_run}
