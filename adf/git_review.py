"""Prepare a bounded, human-reviewable Git handoff. No Git mutations."""

import difflib
import json

from .projects import checkpoint, git
from .snapshots import capture, hashes


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
            if hashes({name: before})[name] != plan["baseline"][name]:
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
