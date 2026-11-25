"""Explicitly reviewed GitHub Issues operations with a durable local outbox."""

import asyncio
import hashlib
import json
from pathlib import Path
import re
import time
import tomllib
from urllib.parse import quote

from .artifacts import read_result
from .codex import environment
from .research import plain_text

STATUS = {"proposed", "ready", "in-progress", "experimenting", "validating", "paused", "blocked", "local-done"}
PRIORITY = {"P1", "P2", "P3"}
PERMISSIONS = {"proposal": "create_issue", "comment": "comment", "progress": "update_issue",
               "depends": "update_issue", "label": "update_issue", "checklist": "update_issue",
               "complete": "close_issue"}
ROLE_ACTIONS = {"coordinator": {"proposal", "comment", "depends", "label"},
                "developer": {"comment", "progress", "checklist", "complete"}}
CHECKBOX = re.compile(r"^(\s*[-*+] \[)([xX ])(\] +)(.+)$")
VALID_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


def number(value):
    if type(value) is not int or not 1 <= value < 2**31:
        raise ValueError("GitHub Issue 番号が不正です")
    return value


def label(value):
    if (not plain_text(value, 50) or value.strip() in (".", "..")
            or any(ord(char) < 32 for char in value)):
        raise ValueError("ラベル名を指定してください")
    return value


def normalized_title(title):
    return " ".join(re.sub(r"\s*\[AI\]$", "", title, flags=re.I).casefold().split())


def validate(kind, payload):
    fields = {"proposal": {"title", "body", "priority"}, "comment": {"issue", "body"},
              "progress": {"issue", "status", "priority"}, "depends": {"issue", "blocked_by"},
              "label": {"issue", "name", "enabled"}, "checklist": {"issue", "criterion", "checked"},
              "complete": {"issue"}}
    if kind not in fields or not isinstance(payload, dict) or set(payload) != fields[kind]:
        raise ValueError("GitHub 操作の引数が不正です")
    if kind != "proposal":
        number(payload["issue"])
    if kind in {"proposal", "progress"} and payload["priority"] not in ("", *PRIORITY):
        raise ValueError("優先度を P1、P2、P3、空欄のいずれかで指定してください")
    if kind in {"proposal", "comment"} and (not plain_text(payload["body"], 12000)
                                           or "<!-- research-meta:" in payload["body"]
                                           or "<!-- adf-operation:" in payload["body"]):
        raise ValueError("本文を指定してください。ADF の予約マーカーは使用できません")
    if kind == "proposal" and not plain_text(payload["title"], 240):
        raise ValueError("提案名を指定してください")
    if kind == "progress" and payload["status"] not in tuple(STATUS):
        raise ValueError("既存の ADF 状態を指定してください")
    if kind == "depends" and number(payload["blocked_by"]) == payload["issue"]:
        raise ValueError("同じ Issue を依存先にできません")
    if kind == "label":
        label(payload["name"])
        if type(payload["enabled"]) is not bool:
            raise ValueError("ラベルの追加・削除を指定してください")
    if kind == "checklist" and (not plain_text(payload["criterion"], 300)
                                or type(payload["checked"]) is not bool):
        raise ValueError("受け入れ条件とチェック状態を指定してください")


async def gh_api(repository, method, endpoint, payload=None, paginate=False):
    if not VALID_REPO.fullmatch(repository) or any(part in (".", "..") for part in repository.split("/")):
        raise ValueError("登録済みの GitHub リポジトリが必要です")
    args = ["gh", "api", "--hostname", "github.com", "--method", method,
            "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10",
            f"repos/{repository}/{endpoint}"]
    if paginate:
        args += ["--paginate", "--slurp"]
    if payload is not None:
        args += ["--input", "-"]
    process = await asyncio.create_subprocess_exec(
        *args, cwd=Path.home(), env={**environment(), "GH_PROMPT_DISABLED": "1"},
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(
            process.communicate(json.dumps(payload).encode() if payload is not None else None), 30)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode:
        raise ValueError("GitHub API の結果を確認できません。対象 Issue と gh の権限を確認してください")
    result = json.loads(out) if out.strip() else None
    return [item for page in result for item in page] if paginate else result


class GitHub:
    def set_tracker_policy(self, project, operations):
        repo = self.project(project)
        if (not repo["github"] or not isinstance(operations, list)
                or any(not isinstance(op, str) or op not in PERMISSIONS for op in operations)):
            raise ValueError("GitHub リポジトリと許可する操作を指定してください")
        with self.store.db:
            self.store.db.execute("INSERT OR REPLACE INTO tracker_policy VALUES (?,?)",
                                  (project, json.dumps(sorted(set(operations)))))
        return True

    def tracker_allowed(self, project, kind):
        policy = self.store.one("SELECT operations FROM tracker_policy WHERE project=?", (project["id"],))
        if project["archived"] or not policy or kind not in json.loads(policy["operations"]):
            raise ValueError("この操作は ADF の操作ポリシーで許可されていません")
        try:
            configured = read_result(Path(project["path"]) / "agents", "config.toml", size=65536)
        except FileNotFoundError:
            return
        if configured["next"] != configured["total"]:
            raise ValueError("トラッカー設定ファイルが大きすぎます")
        options = tomllib.loads(configured["text"]).get("tracker", {})
        github = options.get("github", {})
        if (options.get("backend") != "github" or github.get("repository") != project["github"]
                or github.get(PERMISSIONS[kind]) not in ("allow", "ask")):
            raise ValueError("プロジェクトのトラッカーポリシーが操作を許可していません")

    def draft_tracker(self, project, kind, payload):
        return self.save_tracker_draft(project, kind, payload, "human")

    def save_tracker_draft(self, project, kind, payload, actor):
        row = self.project(project)
        validate(kind, payload)
        self.tracker_allowed(row, kind)
        if actor != "human" and kind not in ROLE_ACTIONS.get(actor, set()):
            raise ValueError("このロールでは操作を提案できません")
        request = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        identity = hashlib.sha256(f"{row['github']}\0{kind}\0{request}".encode()).hexdigest()
        with self.store.db:
            self.store.db.execute("INSERT OR IGNORE INTO tracker_operation "
                                  "VALUES (?,?,?,?,?,?,'pending',NULL,?)",
                                  (identity, project, row["github"], kind, request, actor, time.time()))
        return identity

    async def tracker_issue(self, project, issue):
        row = self.project(project)
        issue = number(issue)
        info = await fetch_issue(row["github"], issue)
        dependencies = await gh_api(row["github"], "GET", f"issues/{issue}/dependencies/blocked_by")
        comments = await gh_api(row["github"], "GET", f"issues/{issue}/comments?per_page=20")
        return {**{key: info.get(key) for key in ("number", "title", "state", "state_reason", "html_url", "updated_at")},
                "labels": [item["name"] for item in info.get("labels", [])],
                "body": str(info.get("body") or "")[:12000],
                "blocked_by": [item["number"] for item in dependencies],
                "comments": [str(item.get("body") or "")[:1500] for item in comments[-8:]]}

    async def review_tracker(self, operation, approve):
        if not isinstance(operation, str) or type(approve) is not bool:
            raise ValueError("承認要求 ID と承認・却下を指定してください")
        draft = self.store.one("SELECT * FROM tracker_operation WHERE id=?", (operation,))
        if not draft or draft["state"] != "pending":
            raise ValueError("処理待ちの承認要求がありません。送信結果が不明な要求は GitHub で照合してください")
        if not approve:
            with self.store.db:
                self.store.db.execute("UPDATE tracker_operation SET state='declined' WHERE id=?", (operation,))
            return False
        project = self.project(draft["project"])
        if project["github"] != draft["repository"]:
            raise ValueError("登録リポジトリが変わりました。承認内容を見直してください")
        self.tracker_allowed(project, draft["kind"])
        with self.store.db:
            self.store.db.execute("UPDATE tracker_operation SET state='sending' WHERE id=?", (operation,))
        # Retain 'sending' across transport failures or daemon restarts. This
        # forbids replay when GitHub might already have accepted a mutation.
        result = await perform(draft["repository"], draft["kind"], json.loads(draft["payload"]), operation,
                               draft["actor"])
        with self.store.db:
            self.store.db.execute("UPDATE tracker_operation SET state='confirmed',result=? WHERE id=?",
                                  (json.dumps(result, ensure_ascii=False), operation))
        return result

    async def tracker_tool(self, row, tool, args):
        try:
            if tool == "adf_read_github_issue" and set(args) == {"issue"}:
                issue = await self.tracker_issue(row["project"], args["issue"])
                return True, json.dumps({"untrusted_github_data": issue}, ensure_ascii=False)
            if tool == "adf_draft_github" and set(args) == {"kind", "payload_json"}:
                operation = self.save_tracker_draft(row["project"], args["kind"], json.loads(args["payload_json"]),
                                                    row["role"])
                return True, f"Draft {operation} is stored locally for human review. No GitHub change was made."
        except (TypeError, ValueError, OSError, TimeoutError):
            return False, "Issue read or draft rejected by the repository or ADF policy."
        return False, "Invalid tracker request."


async def fetch_issue(repository, issue):
    result = await gh_api(repository, "GET", f"issues/{issue}")
    if not isinstance(result, dict) or "pull_request" in result:
        raise ValueError("対象は GitHub Issue に限ります")
    return result


async def propose(repository, payload, key, actor):
    issues = await gh_api(repository, "GET", "issues?state=all&per_page=100", paginate=True)
    title = normalized_title(payload["title"])
    for issue in issues:
        if "pull_request" in issue:
            continue
        if normalized_title(issue["title"]) == title or f'"key": "adf-{key}"' in (issue.get("body") or ""):
            return {"number": issue["number"], "duplicate": True}
    metadata = json.dumps({"key": "adf-" + key, "origin": "human" if actor == "human" else "ai", "created_by": "ai"})
    labels = ["status:proposed"]
    if payload["priority"]:
        labels.append("priority:" + payload["priority"].lower())
    issue = await gh_api(repository, "POST", "issues", {
        "title": payload["title"] if actor == "human" else payload["title"].rstrip() + " [AI]", "body": payload["body"] + f"\n\n<!-- research-meta: {metadata} -->",
        "labels": labels,
    })
    if not set(labels) <= {item["name"] for item in issue.get("labels", [])}:
        raise ValueError("提案は作成されました。ラベルは GitHub で確認してください")
    return {"number": issue["number"]}


def checklist(body, criterion, checked):
    lines = body.splitlines(keepends=True)
    matches = [(index, match) for index, line in enumerate(lines)
               if (match := CHECKBOX.fullmatch(line.rstrip("\r\n"))) and match[4].strip() == criterion.strip()]
    if len(matches) != 1:
        raise ValueError("対象のチェック項目を一意に特定できません")
    index, match = matches[0]
    offset = len(match[1])
    lines[index] = lines[index][:offset] + ("x" if checked else " ") + lines[index][offset + 1:]
    return "".join(lines)


async def perform(repository, kind, payload, key, actor):
    if kind == "proposal":
        return await propose(repository, payload, key, actor)
    number_ = payload["issue"]
    endpoint = f"issues/{number_}"
    issue = await fetch_issue(repository, number_)
    if kind == "comment":
        await gh_api(repository, "POST", endpoint + "/comments",
                     {"body": payload["body"] + f"\n\n<!-- adf-operation: {key} -->"})
    elif kind == "depends":
        target = await fetch_issue(repository, payload["blocked_by"])
        await gh_api(repository, "POST", endpoint + "/dependencies/blocked_by", {"issue_id": target["id"]})
    elif kind == "checklist":
        content = checklist(issue.get("body") or "", payload["criterion"], payload["checked"])
        await gh_api(repository, "PATCH", endpoint, {"body": content})
    elif kind == "complete":
        await gh_api(repository, "PATCH", endpoint, {"state": "closed", "state_reason": "completed"})
    else:
        current = {item["name"] for item in issue.get("labels", [])}
        if kind == "label":
            name = payload["name"]
            added = {name} - current if payload["enabled"] else set()
            removed = current & {name} if not payload["enabled"] else set()
        else:
            desired = {"status:" + payload["status"]}
            axes = ("status:",)
            if payload["priority"]:
                desired.add("priority:" + payload["priority"].lower())
                axes += ("priority:",)
            added = desired - current
            removed = {name for name in current - desired if name.lower().startswith(axes)}
        label_endpoint = endpoint + "/labels"
        if added:
            result = await gh_api(repository, "POST", label_endpoint, {"labels": sorted(added)})
            if not added <= {item["name"] for item in result}:
                raise ValueError("GitHub 上でラベルの反映を確認できません")
        for name in sorted(removed):
            await gh_api(repository, "DELETE", label_endpoint + "/" + quote(name, safe=""))
    return {"number": number_}
