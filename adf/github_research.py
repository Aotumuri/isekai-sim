"""GitHub owns eligibility and completion; local task IDs reference execution evidence."""

import asyncio
import hashlib
import json

from .research import autonomous, plain_text
from .tracker import CHECKBOX, checklist, fetch_issue, gh_api, number

ACTIVE_STATUS = {"in-progress", "experimenting", "validating", "local-done"}


def status(issue):
    labels = [item["name"][7:] for item in issue.get("labels", []) if item["name"].startswith("status:")]
    return labels[0] if len(labels) == 1 else None


def priority(issue):
    labels = {item["name"] for item in issue.get("labels", [])}
    return next((rank for rank in (1, 2, 3) if f"priority:p{rank}" in labels), 4)


def completed(issue):
    return issue["state"] == "closed" and issue.get("state_reason") == "completed"


def fingerprint(issue, deps):
    payload = [issue["id"], issue["title"], issue.get("body"), sorted(item["id"] for item in deps)]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode()).hexdigest()


class GitHubResearch:
    issue_fingerprint = staticmethod(fingerprint)

    def github_run(self, row):
        return self.store.one("SELECT * FROM github_run WHERE session=? AND generation=?",
                              (row["id"], row["generation"]))

    async def load_issue(self, repository, issue):
        item, deps = await asyncio.gather(
            fetch_issue(repository, issue),
            gh_api(repository, "GET", f"issues/{issue}/dependencies/blocked_by?per_page=100", paginate=True))
        return item, deps

    async def select_issue(self, repository, ids):
        # Bound simultaneous GitHub CLI children, even for a scope of 20 issues.
        slots = asyncio.Semaphore(4)

        async def load(issue):
            async with slots:
                return await self.load_issue(repository, issue)

        results = await asyncio.gather(*(load(issue) for issue in ids))
        ready = [entry for entry in results if entry[0]["state"] == "open" and status(entry[0]) == "ready"
                 and not entry[0].get("assignees") and all(completed(dep) for dep in entry[1])]
        return min(ready, key=lambda entry: (priority(entry[0]), entry[0]["number"]), default=None), all(
            completed(entry[0]) for entry in results)

    def issue_task(self, project, repository, issue, deps):
        # Stable internal FK for research_experiment, hidden from the local task list.
        with self.store.db:
            entry = self.store.one("SELECT task FROM github_task WHERE project=? AND repository=? AND number=?",
                                   (project, repository, issue["number"]))
            title = f"GitHub {repository}#{issue['number']}"
            if entry is None:
                task = self.store.db.execute("INSERT INTO research_task(project,title,criteria,priority,dependencies) "
                                             "VALUES(?,?,?,?,?)", (project, title, "", priority(issue), "[]")).lastrowid
                self.store.db.execute("INSERT INTO github_task VALUES(?,?,?,?)",
                                      (project, repository, issue["number"], task))
            else:
                task = entry["task"]
        return {"id": task, "title": title, "criteria": "",
                "external": {"title": issue["title"][:500], "body": (issue.get("body") or "")[:6000],
                             "dependencies": [item["number"] for item in deps]}}

    async def start_project_research(self, project, tasks, scope, **limits):
        repo = self.project(project)
        limits = self.research_settings(project, **limits)
        if not repo["github"]:
            return self.start_research(project, tasks, scope, **limits)
        if not isinstance(tasks, list) or not 1 <= len(tasks) <= 20 or not plain_text(scope, 8000):
            raise ValueError("承認する GitHub Issue 番号と研究範囲を指定してください")
        ids = list(dict.fromkeys(number(issue) for issue in tasks))
        self.tracker_allowed(repo, "progress")
        epoch = self.stop_epochs.get(project, 0)
        result, _ = await self.select_issue(repo["github"], ids)
        if self.shutdown or self.stop_epochs.get(project, 0) != epoch:
            raise ValueError("課題取得中に停止が指定されました")
        if self.project(project)["github"] != repo["github"]:
            raise ValueError("課題取得中にリポジトリが変更されました")
        approved = {"ids": ids, "instructions": scope, "repository": repo["github"]}
        if result is None:
            if autonomous({"preset": limits.get("preset_settings") or {}}):
                return self.begin_research(project, None, approved, **limits)
            raise ValueError("承認範囲に着手可能な GitHub Issue がありません")
        issue, deps = result
        task = self.issue_task(project, repo["github"], issue, deps)
        return self.begin_research(project, task, approved, github={
            "repository": repo["github"], "issue": issue["number"], "fingerprint": fingerprint(issue, deps),
        }, **limits)

    def pin_issue(self, session, generation, github):
        self.store.db.execute("INSERT OR REPLACE INTO github_run VALUES (?,?,?,?,?,NULL,'claim')",
                              (session, generation, github["repository"], github["issue"], github["fingerprint"]))

    def guard_tracker(self, operation, row, run):
        with self.store.db:
            self.store.db.execute("INSERT OR IGNORE INTO tracker_guard VALUES (?,?,?,?)",
                                  (operation, row["id"], row["generation"], run["fingerprint"]))

    async def current_issue(self, row, run, *, accept_changes=False):
        if self.project(row["project"])["github"] != run["repository"]:
            raise ValueError("研究対象のリポジトリが変更されました")
        issue, deps = await self.load_issue(run["repository"], run["issue"])
        if ((not accept_changes and fingerprint(issue, deps) != run["fingerprint"]) or issue["state"] != "open"
                or issue.get("assignees") or not all(completed(dep) for dep in deps)):
            raise ValueError("GitHub の課題・依存・担当が変更されました。対象を再確認してください")
        return issue, deps

    async def check_tracker_guard(self, guard, draft):
        row = self.store.session(guard["session"])
        run = self.github_run(row)
        if not run or row["generation"] != guard["generation"] or run["fingerprint"] != guard["fingerprint"]:
            raise ValueError("停止または研究範囲の変更により、この承認要求は失効しました")
        issue, deps = await self.current_issue(row, run)
        if draft["kind"] == "complete":
            run_details = self.store.one("SELECT * FROM research_run WHERE session=?", (row["id"],))
            plan = json.loads(run_details["scope"]).get("experiment") or {}
            if plan.get("artifacts") and not await self.verified_job(row, run_details):
                raise ValueError("現在のソースと必須成果物が承認時の実験に一致しません")
        latest = self.store.session(row["id"])
        latest_run = self.github_run(latest)
        allowed = {"ready"} if run["phase"] == "claim" else ACTIVE_STATUS
        if latest_run != run or status(issue) not in allowed:
            raise ValueError("Issue の状態が変わりました")
        return issue, deps

    def checklist_expectation(self, draft, before):
        payload = json.loads(draft["payload"])
        initial, deps = before
        expected = dict(initial, body=checklist(initial.get("body") or "", payload["criterion"], payload["checked"]))
        return fingerprint(expected, deps)

    async def refresh_checklist_guard(self, guard, draft, expected):
        payload = json.loads(draft["payload"])
        actual, deps = await self.load_issue(draft["repository"], payload["issue"])
        if (fingerprint(actual, deps) != expected or actual["state"] != "open"
                or actual.get("assignees") or status(actual) not in ACTIVE_STATUS
                or not all(completed(dep) for dep in deps)):
            raise ValueError("GitHub のチェックリスト更新結果が想定と一致しません")
        # The operation can finish after Stop. Update only its original checkpoint.
        return (expected, guard["session"], guard["generation"], guard["fingerprint"],
                draft["repository"], payload["issue"])

    async def submit_research_operation(self, row, run, kind, payload, *, force_review=False):
        nonce = f"{row['id']}:{row['generation']}:{run['issue']}:{run['phase']}"
        key = self.save_tracker_draft(row["project"], kind, payload, "developer", nonce=nonce)
        self.guard_tracker(key, row, run)
        with self.store.db:
            self.store.db.execute("UPDATE github_run SET operation=? WHERE session=?", (key, row["id"]))
        entry = self.store.one("SELECT state FROM tracker_operation WHERE id=?", (key,))
        if entry["state"] == "confirmed":
            return True
        result = {"approval": key} if force_review else await self.send_tracker(key, True, automatic=True)
        if "approval" in result:
            self.pause_github(row, f"GitHub 操作の承認待ち: {key}")
            return False
        return True

    def pause_github(self, row, reason):
        latest = self.store.session(row["id"])
        if latest["generation"] != row["generation"] or latest["state"] not in ("running", "idle"):
            return
        with self.store.db:
            self.store.update_session(row["id"], state="paused")
            self.store.db.execute("UPDATE research_run SET state='paused' WHERE session=?", (row["id"],))
            self.store.event(row["id"], "github_pause", reason)
        self.release_inactive_legacy(row["id"])

    async def before_github_turn(self, row):
        run = self.github_run(row)
        if not run:
            return True
        if self.unknown_tracker_operation(run["repository"], run["issue"]):
            raise ValueError("GitHub への送信結果を照合してから再開してください")
        issue, _ = await self.current_issue(row, run)
        if not self.visible(row["id"], row["generation"], ("running",)):
            return False
        if run["phase"] == "claim":
            if status(issue) != "ready":
                raise ValueError("GitHub Issue は着手可能な状態ではありません")
            if not await self.submit_research_operation(row, run, "progress",
                                                        {"issue": run["issue"], "status": "in-progress", "priority": ""}):
                return False
            confirmed, _ = await self.current_issue(row, run)
            if not self.visible(row["id"], row["generation"], ("running",)):
                return False
            if status(confirmed) != "in-progress":
                raise ValueError("GitHub で着手を確認できません")
            with self.store.db:
                self.store.db.execute("UPDATE github_run SET phase='work',operation=NULL WHERE session=? AND generation=?",
                                      (row["id"], row["generation"]))
        elif run["phase"] != "work" or status(issue) not in ACTIVE_STATUS:
            raise ValueError("GitHub Issue の進捗が変更されました")
        return True

    async def finish_github(self, row, turn):
        run = self.github_run(row)
        research = self.research_for(row)
        try:
            if not research or research["decision_turn"] != turn:
                self.pause_github(row, "実験または根拠付きの課題判断が返されませんでした")
                return
            decision = json.loads(research["decision"])
            if decision["outcome"] != "completed":
                self.pause_github(row, decision["summary"])
                return
            issue, _ = await self.current_issue(row, run)
            if not self.visible(row["id"], row["generation"], ("idle",)):
                return
            if any(match[2] == " " for line in (issue.get("body") or "").splitlines()
                   if (match := CHECKBOX.fullmatch(line))):
                raise ValueError("GitHub の未完了チェック項目を確認してください")
            with self.store.db:
                self.store.db.execute("UPDATE github_run SET phase='finish',operation=NULL WHERE session=?", (row["id"],))
            run = self.github_run(row)
            verified = await self.verified_job(row, research)
            if await self.submit_research_operation(row, run, "complete", {"issue": run["issue"]},
                                                    force_review=not verified):
                await self.next_github(row, research, run, decision["summary"])
        except Exception as error:
            self.pause_github(row, str(error) if isinstance(error, ValueError) else type(error).__name__)

    async def next_github(self, row, research, run, summary):
        # Remote confirmation is authoritative; a successful mutation RPC alone is insufficient.
        issue, deps = await self.load_issue(run["repository"], run["issue"])
        if not completed(issue) or fingerprint(issue, deps) != run["fingerprint"]:
            raise ValueError("GitHub で完了状態を確認できません")
        scope = json.loads(research["scope"])
        selected, all_done = await self.select_issue(run["repository"], scope["ids"])
        if not self.visible(row["id"], row["generation"], ("idle", "paused")):
            return
        with self.store.db:
            self.store.event(row["id"], "research_result", {"issue": run["issue"], "summary": summary})
            if all_done:
                self.store.db.execute("UPDATE research_run SET state='completed' WHERE session=?", (row["id"],))
                self.store.update_session(row["id"], state="paused")
            elif selected and not self.research_limit(self.store.session(row["id"]), research):
                item, deps = selected
                task = self.issue_task(row["project"], run["repository"], item, deps)
                prompt = self.research_prompt(task, scope["instructions"], scope.get("experiment"))
                self.store.db.execute("UPDATE research_run SET task=?,state='active',decision_turn=NULL,decision=NULL "
                                      "WHERE session=?", (task["id"], row["id"]))
                self.pin_issue(row["id"], row["generation"], {"repository": run["repository"],
                               "issue": item["number"], "fingerprint": fingerprint(item, deps)})
                self.store.update_session(row["id"], state="running", prompt=prompt)
                self.background(self.run_turn(row["id"], row["generation"], prompt, self.settings("developer")))
            elif not selected and autonomous(scope):
                self.queue_research(row)
            else:
                self.pause_github(row, "研究予算に到達、または承認範囲に着手可能な課題がありません")
        self.release_inactive_legacy(row["id"])

    async def resume_project_research(self, project, accept_issue_changes=False, tokens=None):
        if type(accept_issue_changes) is not bool:
            raise ValueError("Issue の変更を確認した場合だけ承認してください")
        row = self.session_for(project, "developer")
        current = self.store.one("SELECT * FROM research_run WHERE session=?", (row["id"],)) if row else None
        current = self.extend_token_budget(row, current, tokens)
        remote = self.store.one("SELECT * FROM github_run WHERE session=?", (row["id"],)) if row else None
        if not remote:
            return self.resume_research(project)
        if current["state"] == "completed" or row["state"] not in ("paused", "interrupted", "quota"):
            raise ValueError("再開可能な GitHub 研究実行がありません")
        op = self.store.one("SELECT state FROM tracker_operation WHERE id=?", (remote["operation"],))
        op_state = op["state"] if op else None
        if op_state == "pending" or self.unknown_tracker_operation(remote["repository"], remote["issue"]):
            raise ValueError("GitHub 操作の承認と送信結果を確認してください")
        if remote["phase"] == "finish" and op_state == "confirmed":
            return await self.resume_confirmed_completion(row, current, remote)
        epoch = self.stop_epochs.get(project, 0)
        accepted = bool(accept_issue_changes and remote["phase"] != "claim")
        issue, deps = await self.current_issue(row, remote, accept_changes=accepted)
        if (self.shutdown or self.stop_epochs.get(project, 0) != epoch
                or not self.visible(row["id"], row["generation"], ("paused", "interrupted", "quota"))):
            raise ValueError("再開確認中に実行状態が変更されました")
        progressed = remote["phase"] != "claim" or op_state == "confirmed"
        if status(issue) not in (ACTIVE_STATUS if progressed else {"ready"}):
            raise ValueError("GitHub Issue の進捗が変更されました")
        changed = fingerprint(issue, deps) != remote["fingerprint"]
        scope = json.loads(current["scope"])
        if remote["phase"] == "finish" and not changed:
            required = (scope.get("experiment") or {}).get("artifacts")
            if not required or await self.verified_job(row, current):
                if self.stop_epochs.get(project, 0) != epoch:
                    raise ValueError("再開確認中に停止が指定されました")
                return await self.renew_completion(row, current, remote)
        task = self.issue_task(project, remote["repository"], issue, deps)
        if reason := self.research_budget_reason(row, current):
            raise ValueError(reason)
        if self.uncertain_experiment(row, task, current):
            raise ValueError("中断した実験を確認してください")
        if changed:
            scope["evidence_after"] = row["turn_requests"]
        job = None if changed else self.deferred_evaluation(row, current)
        prompt = (self.evaluation_prompt(job) if job else
                  self.research_prompt(task, scope["instructions"], scope.get("experiment")))
        session = self.reserve(project, "developer", prompt, True, launch=False)
        generation = self.store.session(session)["generation"]
        with self.store.db:
            self.store.db.execute("UPDATE research_run SET generation=?,scope=?,state='active',decision=NULL,decision_turn=NULL "
                                  "WHERE session=?", (generation, json.dumps(scope), session))
            self.store.db.execute("UPDATE github_run SET generation=?,phase=?,operation=NULL,fingerprint=? WHERE session=?",
                                  (generation, "work" if progressed else "claim", fingerprint(issue, deps), session))
            self.claim_deferred_evaluation(job)
        self.background(self.run_turn(session, generation, prompt, self.settings("developer"), resume=not job,
                                      job=job["id"] if job else None))
        return session

    async def resume_confirmed_completion(self, row, current, remote):
        session = self.reserve(row["project"], "developer", row["prompt"], True, launch=False)
        resumed = self.store.session(session)
        with self.store.db:
            self.store.update_session(session, state="idle")
            self.store.db.execute("UPDATE research_run SET generation=? WHERE session=?", (resumed["generation"], session))
            self.store.db.execute("UPDATE github_run SET generation=? WHERE session=?", (resumed["generation"], session))
        try:
            await self.next_github(resumed, current, remote, json.loads(current["decision"])["summary"])
        except Exception as error:
            self.pause_github(resumed, str(error) if isinstance(error, ValueError) else type(error).__name__)
            raise
        return session

    async def renew_completion(self, row, current, remote):
        if not current["decision"]:
            raise ValueError("保存済みの完了判断がありません")
        session = self.reserve(row["project"], "developer", row["prompt"], True, launch=False)
        current_row = self.store.session(session)
        with self.store.db:
            self.store.update_session(session, state="idle")
            self.store.db.execute("UPDATE research_run SET generation=? WHERE session=?",
                                  (current_row["generation"], session))
            self.store.db.execute("UPDATE github_run SET generation=?,operation=NULL WHERE session=?",
                                  (current_row["generation"], session))
        try:
            await self.submit_research_operation(current_row, self.github_run(current_row), "complete",
                                                 {"issue": remote["issue"]}, force_review=True)
        except Exception as error:
            self.pause_github(current_row, str(error) if isinstance(error, ValueError) else type(error).__name__)
            raise
        return session
