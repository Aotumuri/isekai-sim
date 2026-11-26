"""Explicitly reviewed GitHub Issues operations with a durable local outbox."""

import asyncio
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
from urllib.parse import quote

from .codex import environment
from .research import plain_text
from .tracker_policy import TrackerPolicy

STATUS = {"proposed", "ready", "in-progress", "experimenting", "validating", "paused", "blocked", "local-done"}
PRIORITY = {"P1", "P2", "P3"}
ROLE_ACTIONS = {"coordinator": {"proposal", "comment", "depends", "label"},
                "developer": {"proposal", "comment", "progress", "checklist", "complete"}}
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


class GitHub(TrackerPolicy):
    def unknown_tracker_operation(self, repository, issue):
        return self.store.one(
            "SELECT id FROM tracker_operation WHERE repository=? COLLATE NOCASE AND state='sending' "
            "AND kind IN ('checklist','progress','complete') AND json_extract(payload, '$.issue')=?",
            (repository, issue))

    def draft_tracker(self, project, kind, payload):
        key = self.save_tracker_draft(project, kind, payload, "human")
        existing = self.store.one("SELECT * FROM tracker_operation WHERE id=?", (key,))
        if existing["state"] == "unapplied":
            latest = self.store.one(
                "SELECT id,state FROM tracker_operation WHERE project=? AND repository=? AND kind=? "
                "AND payload=? AND actor='human' ORDER BY created DESC LIMIT 1",
                (project, existing["repository"], kind, existing["payload"]))
            if latest and latest["state"] != "unapplied":
                return latest["id"]
            return self.save_tracker_draft(project, kind, payload, "human", nonce=uuid.uuid4().hex)
        return key

    def save_tracker_draft(self, project, kind, payload, actor, *, nonce=""):
        row = self.project(project)
        validate(kind, payload)
        self.tracker_allowed(row, kind)
        if actor != "human" and kind not in ROLE_ACTIONS.get(actor, set()):
            raise ValueError("このロールでは操作を提案できません")
        request = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        material = f"{row['github']}\0{kind}\0{request}"
        identity = hashlib.sha256((material + (f"\0{nonce}" if nonce else "")).encode()).hexdigest()
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
        return await self.send_tracker(operation, approve, automatic=False)

    async def send_tracker(self, operation, approve, *, automatic):
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
        policy = self.tracker_allowed(project, draft["kind"])
        payload = json.loads(draft["payload"])
        guard = self.store.one("SELECT * FROM tracker_guard WHERE operation=?", (operation,))
        if automatic and (policy != "allow" or self.tracker_requires_review(draft, guard)):
            return {"approval": operation}
        expected = await self.check_tracker_guard(guard, draft) if guard else None
        before = expected[0] if expected else None
        if draft["kind"] == "checklist" and before is None:
            before = await fetch_issue(draft["repository"], payload["issue"])
            if before["state"] != "open":
                raise ValueError("開いている Issue のチェックリストを指定してください")
        if guard or before is not None:
            fresh = self.store.one("SELECT state FROM tracker_operation WHERE id=?", (operation,))
            if fresh["state"] != "pending":
                raise ValueError("この操作は既に処理されています")
            project = self.project(draft["project"])
            if project["github"] != draft["repository"]:
                raise ValueError("登録リポジトリが変わりました。承認内容を見直してください")
            policy = self.tracker_allowed(project, draft["kind"])
            if automatic and (policy != "allow" or self.tracker_requires_review(draft, guard)):
                return {"approval": operation}
        if payload.get("issue") is not None and self.unknown_tracker_operation(draft["repository"], payload["issue"]):
            raise ValueError("同じ Issue の送信結果が不明です。先に照合してください")
        checklist_hash = None
        if draft["kind"] == "checklist":
            if expected:
                checklist_hash = self.checklist_expectation(draft, expected)
            else:
                after = dict(before, body=checklist(before.get("body") or "", payload["criterion"], payload["checked"]))
                checklist_hash = standalone_checklist_hash(after)
        with self.store.db:
            self.store.db.execute("UPDATE tracker_operation SET state='sending' WHERE id=?", (operation,))
            if checklist_hash:
                self.store.db.execute("INSERT INTO tracker_expectation VALUES (?,?,?)",
                                      (operation, checklist_hash, standalone_checklist_hash(before) if not guard else None))
        # The sending record and expected result survive timeout and daemon restart.
        args = (draft["repository"], draft["kind"], payload, operation, draft["actor"])
        self.tracker_sending.add(operation)
        try:
            result = await (perform(*args, before=before) if checklist_hash else perform(*args))
            change = await self.confirm_checklist_result(draft, guard, checklist_hash) if checklist_hash else None
            self.confirm_tracker(operation, result, change)
            return result
        finally:
            self.tracker_sending.discard(operation)

    async def confirm_checklist_result(self, draft, guard, expected):
        if guard:
            return await self.refresh_checklist_guard(guard, draft, expected)
        issue = await fetch_issue(draft["repository"], json.loads(draft["payload"])["issue"])
        if standalone_checklist_hash(issue) != expected:
            raise ValueError("GitHub のチェックリスト更新結果が想定と一致しません")
        return None

    def confirm_tracker(self, operation, result, change=None):
        with self.store.db:
            updated = self.store.db.execute(
                "UPDATE tracker_operation SET state='confirmed',result=? WHERE id=? AND state='sending'",
                (json.dumps(result, ensure_ascii=False), operation))
            if updated.rowcount and change:
                advances = self.store.db.execute("UPDATE github_run SET fingerprint=? WHERE session=? AND generation=? "
                                                "AND fingerprint=? AND repository=? AND issue=?", change)
                if advances.rowcount and change[0] != change[3]:
                    self.store.db.execute(
                        "UPDATE tracker_operation SET state='expired' WHERE state='pending' AND id IN ("
                        "SELECT operation FROM tracker_guard WHERE session=? AND generation=? AND fingerprint=?)",
                        change[1:4])

    async def reconcile_tracker(self, operation, accept_external_edit=False, confirm_unapplied=False):
        if (not isinstance(operation, str) or type(accept_external_edit) is not bool
                or type(confirm_unapplied) is not bool or (accept_external_edit and confirm_unapplied)):
            raise ValueError("操作 ID と照合方法を指定してください")
        if operation in self.tracker_sending:
            raise ValueError("送信処理が終了してから照合してください")
        draft = self.store.one("SELECT * FROM tracker_operation WHERE id=? AND state='sending'", (operation,))
        if not draft or draft["kind"] not in ("progress", "complete", "checklist"):
            raise ValueError("結果不明の進捗・完了・チェックリスト操作を指定してください")
        payload = json.loads(draft["payload"])
        if confirm_unapplied:
            return await self.confirm_unapplied_checklist(draft, payload)
        if draft["kind"] == "checklist":
            expected = self.store.one("SELECT fingerprint FROM tracker_expectation WHERE operation=?", (operation,))
            guard = self.store.one("SELECT * FROM tracker_guard WHERE operation=?", (operation,))
            if not expected and not accept_external_edit:
                raise ValueError("旧形式の送信記録です。GitHub を確認して --accept-external-edit で照合してください")
            result = {"number": payload["issue"], "reconciled": True}
            try:
                if not expected:
                    raise ValueError("照合用の期待値がありません")
                change = await self.confirm_checklist_result(draft, guard, expected["fingerprint"])
            except ValueError:
                if not accept_external_edit:
                    raise
                actual = await fetch_issue(draft["repository"], payload["issue"])
                body = actual.get("body") or ""
                if (actual["state"] != "open"
                        or checklist(body, payload["criterion"], payload["checked"]) != body):
                    raise ValueError("要求されたチェック状態を GitHub で確認できません") from None
                # Preserve the original pinned fingerprint. Only explicit research
                # resumption can re-approve a changed external task.
                change = None
                result["external_edit"] = True
            self.confirm_tracker(operation, result, change)
            return result
        issue = await fetch_issue(draft["repository"], payload["issue"])
        names = {item["name"] for item in issue.get("labels", [])}
        if draft["kind"] == "complete":
            confirmed = issue["state"] == "closed" and issue.get("state_reason") == "completed"
        else:
            confirmed = issue["state"] == "open" and {
                name for name in names if name.startswith("status:")} == {f"status:{payload['status']}"}
            if payload["priority"]:
                confirmed = confirmed and {name for name in names if name.startswith("priority:")} == {
                    "priority:" + payload["priority"].lower()}
        if not confirmed:
            raise ValueError("GitHub の現在の状態で操作結果を確認できません")
        result = {"number": payload["issue"], "reconciled": True}
        self.confirm_tracker(operation, result)
        return result

    async def confirm_unapplied_checklist(self, draft, payload):
        expected = self.store.one("SELECT * FROM tracker_expectation WHERE operation=?", (draft["id"],))
        if (draft["kind"] != "checklist" or not expected or not expected["before_fingerprint"]
                or expected["before_fingerprint"] == expected["fingerprint"]):
            raise ValueError("研究外のチェックリストで更新前の状態が記録された操作を指定してください")
        issue = await fetch_issue(draft["repository"], payload["issue"])
        if standalone_checklist_hash(issue) != expected["before_fingerprint"]:
            raise ValueError("GitHub が更新前の状態と一致しません")
        with self.store.db:
            updated = self.store.db.execute("UPDATE tracker_operation SET state='unapplied' "
                                            "WHERE id=? AND state='sending'", (draft["id"],))
        if not updated.rowcount:
            raise ValueError("この操作は既に照合されています")
        return {"number": payload["issue"], "unapplied": True}

    async def tracker_tool(self, row, tool, args):
        try:
            if tool == "adf_read_github_issue" and set(args) == {"issue"}:
                issue = await self.tracker_issue(row["project"], args["issue"])
                return True, json.dumps({"untrusted_github_data": issue}, ensure_ascii=False)
            if tool == "adf_draft_github" and set(args) == {"kind", "payload_json"}:
                kind = args["kind"]
                payload = json.loads(args["payload_json"])
                validate(kind, payload)
                if kind == "complete":
                    return False, "Use the research completion tool for completion, or request human review separately."
                project = self.project(row["project"])
                policy = self.tracker_allowed(project, kind)
                run = self.github_run(row)
                if run and kind != "proposal" and payload.get("issue") != run["issue"]:
                    return False, "Writes in a research run are restricted to the currently owned issue."
                operation = self.save_tracker_draft(row["project"], kind, payload, row["role"],
                                                    nonce=f"{row['id']}:{row['generation']}:{run['issue']}:{run['fingerprint']}"
                                                    if run and kind != "proposal" else "")
                if policy == "allow":
                    if row["role"] == "developer" and kind != "proposal" and not run:
                        return True, f"Draft {operation} requires human review outside GitHub research."
                    if run and kind != "proposal":
                        self.guard_tracker(operation, row, run)
                    prior = self.store.one("SELECT state,result FROM tracker_operation WHERE id=?", (operation,))
                    if prior["state"] == "confirmed":
                        return True, "Already confirmed. " + prior["result"]
                    result = await self.send_tracker(operation, True, automatic=True)
                    return True, json.dumps(result, ensure_ascii=False)
                if run and kind != "proposal":
                    self.guard_tracker(operation, row, run)
                return True, f"Draft {operation} requires human review."

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


def standalone_checklist_hash(issue):
    fields = [issue.get(key) for key in ("id", "number", "title", "body", "state")]
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False).encode()).hexdigest()


async def perform(repository, kind, payload, key, actor, *, before=None):
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
        if before and any(issue.get(key) != before.get(key) for key in ("id", "title", "body", "state", "assignees")):
            raise ValueError("送信直前に GitHub Issue が変更されました")
        content = checklist(issue.get("body") or "", payload["criterion"], payload["checked"])
        await gh_api(repository, "PATCH", endpoint, {"body": content})
    elif kind == "complete":
        if any(match[2] == " " for line in (issue.get("body") or "").splitlines()
               if (match := CHECKBOX.fullmatch(line))):
            raise ValueError("未完了のチェック項目があるためクローズできません")
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
