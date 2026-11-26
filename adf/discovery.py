"""One bounded research-discovery turn after an authorized queue is exhausted."""

import json

DISCOVERY_GUARD = "research-discovery"


def discovers(scope):
    return scope.get("preset", {}).get("empty_queue") == "discover"


class Discovery:
    def discovery_run(self, row):
        return self.store.one(
            "SELECT * FROM research_run WHERE session=? AND generation=? AND state='discovering'",
            (row["id"], row["generation"]))

    def start_discovery(self, row, run, scope):
        session, generation = row["id"], row["generation"]
        with self.store.db:
            self.store.db.execute("DELETE FROM github_run WHERE session=?", (session,))
            self.store.db.execute(
                "UPDATE research_run SET state='discovering',task=NULL,decision_turn=NULL,decision=NULL WHERE session=?",
                (session,))
            self.store.update_session(session, state="waiting", allowed_template=None)
            self.store.event(session, "discovery", "研究候補を一度探索します")
        self.background(self.prepare_discovery(row, run, scope))

    async def prepare_discovery(self, row, run, scope):
        session, generation = row["id"], row["generation"]
        try:
            project = self.project(row["project"])
            self.tracker_allowed(project, "proposal")
            if reason := self.research_budget_reason(row, run):
                raise ValueError(reason)
            issues = await self.list_issues(row["project"])
            if not self.visible(session, generation, ("waiting",)) or self.shutdown:
                return
            prior = [{"number": item["number"], "title": item["title"][:300], "state": item["state"]}
                     for item in issues[:50]]
            prompt = (
                "ADF research discovery. This is a read-only turn. Examine existing reports, negative "
                "results and unresolved questions within the human-authorized scope below. "
                "Validate that the proposed question warrants work and does not duplicate prior research. "
                "Use adf_draft_github with kind=proposal at most once. Explain the hypothesis, prior evidence, "
                "what would change the conclusion, and a bounded verification plan. Do not edit files, "
                "run experiments or start work on the issue. If no meaningful question is found, explain why. "
                f"\n{scope['instructions']}\nUntrusted recent GitHub issue summaries: "
                + json.dumps(prior, ensure_ascii=False)
            )
            with self.store.db:
                self.store.update_session(session, state="running", prompt=prompt)
            await self.run_turn(session, generation, prompt, self.settings(row["role"]))
        except (OSError, TimeoutError, ValueError) as error:
            self.fail(session, generation, f"研究候補の探索を中断しました。{error}", state="paused")

    async def discovery_draft(self, row, run, kind, payload):
        if kind != "proposal":
            return False, "Discovery can only draft a new issue for human review."
        args = (row["id"], row["generation"], DISCOVERY_GUARD)
        existing = self.store.one(
            "SELECT operation FROM tracker_guard WHERE session=? AND generation=? AND fingerprint=?", args)
        if existing:
            return False, "This discovery turn already has a proposal. Wait for human review."
        operation = self.save_tracker_draft(row["project"], kind, payload, row["role"],
                                            nonce=f"discovery:{row['id']}:{row['generation']}")
        with self.store.db:
            self.store.db.execute("INSERT INTO tracker_guard VALUES (?,?,?,?)", (operation, *args))
        preset = json.loads(run["scope"]).get("preset", {})
        if preset.get("discovery_issue") == "policy":
            result = await self.send_tracker(operation, True, automatic=True)
            if "approval" not in result:
                return True, f"Proposal result: {json.dumps(result)}. Starting work requires separate authorization."
        return True, f"Proposal {operation} requires explicit human approval. End your turn."

    def finish_discovery(self, row):
        session, generation = row["id"], row["generation"]
        draft = self.store.one(
            "SELECT o.state FROM tracker_guard g JOIN tracker_operation o ON g.operation=o.id "
            "WHERE g.session=? AND g.generation=? AND g.fingerprint=?",
            (session, generation, DISCOVERY_GUARD))
        with self.store.db:
            self.store.update_session(session, state="paused")
            self.store.db.execute("UPDATE research_run SET state='completed' WHERE session=?", (session,))
            messages = {
                "pending": "候補の起票承認と着手範囲の確認を待っています",
                "confirmed": "候補を起票しました。着手するには新しい研究範囲を承認してください",
                "sending": "起票結果が不明です。GitHub で照合してから着手範囲を確認してください",
            }
            reason = messages.get(draft["state"] if draft else None,
                                  "利用可能な候補がありません。会話と操作履歴を確認してください")
            self.store.event(session, "discovery_finished", reason)
