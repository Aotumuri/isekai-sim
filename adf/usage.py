"""Persist App Server telemetry without confusing cumulative and per-turn counts."""

import json

FIELDS = ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens",
          "totalTokens", "cacheWriteInputTokens")


def tokens_report(raw):
    if not isinstance(raw, dict):
        return {}
    return {key: raw[key] for key in FIELDS if type(raw.get(key)) is int and raw[key] >= 0}


def windows_report(limits):
    buckets = limits.get("rateLimitsByLimitId") or {"codex": limits.get("rateLimits")}
    return {name: {key: {field: value for field, value in (bucket.get(key) or {}).items()
                         if field in {"usedPercent", "resetsAt", "windowDurationMins"}}
                   for key in ("primary", "secondary")} for name, bucket in buckets.items()
            if isinstance(bucket, dict)}


class Usage:
    def associate_usage(self, row, thread, turn, sequence, task, job, limits, initial, model=None):
        with self.store.db:
            self.store.db.execute(
                "INSERT INTO turn_usage(session,thread,turn,sequence,task,job,quota,initial,model) VALUES (?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(session,turn) DO UPDATE SET sequence=excluded.sequence,task=excluded.task,"
                "job=excluded.job,quota=excluded.quota,initial=excluded.initial,model=excluded.model",
                (row["id"], thread, turn, sequence, task, job,
                 json.dumps(windows_report(limits)), int(initial), model or None))

    def receive_usage(self, row, params):
        payload = params.get("tokenUsage", {})
        total = tokens_report(payload.get("total"))
        turn = params.get("turnId")
        if not total or not isinstance(turn, str):
            return
        last = tokens_report(payload.get("last"))
        with self.store.db:
            # The notification can precede the acknowledgement of turn/start.
            self.store.db.execute("INSERT INTO turn_usage(session,thread,turn,total,last) VALUES(?,?,?,?,?) "
                                  "ON CONFLICT(session,turn) DO UPDATE SET total=excluded.total,last=excluded.last",
                                  (row["id"], params["threadId"], turn, json.dumps(total), json.dumps(last)))
            if "totalTokens" in total:
                self.store.update_session(row["id"], tokens=max(row["token_floor"] + total["totalTokens"],
                                                               row["tokens"]))

    def usage_report(self, project):
        self.project(project)
        rows = self.store.all(
            "SELECT u.*, s.role, g.number AS issue FROM turn_usage u JOIN session s ON s.id=u.session "
            "LEFT JOIN github_task g ON g.task=u.task WHERE s.project=? AND u.sequence IS NOT NULL "
            "ORDER BY u.sequence DESC LIMIT 200", (project,))
        prior = {}
        tasks = {}
        models = {}
        for row in reversed(rows):
            thread = row["thread"]
            total = json.loads(row.pop("total") or "{}")
            last = json.loads(row.pop("last") or "{}")
            quota = json.loads(row["quota"])
            base = prior.get(thread)
            baseline = base["total"] if base and row["sequence"] == base["sequence"] + 1 else None
            if row["initial"]:
                baseline = dict.fromkeys(FIELDS, 0)
            delta = ({key: total[key] - baseline[key] for key in total.keys() & baseline.keys()
                      if total[key] >= baseline[key]} if baseline is not None else {})
            previous_quota = base["quota"] if base else {}
            quota_delta = []
            for bucket, windows in quota.items():
                for name, window in windows.items():
                    earlier = previous_quota.get(bucket, {}).get(name, {})
                    if (type(earlier.get("usedPercent")) in (float, int)
                            and type(window.get("usedPercent")) in (float, int)
                            and window.get("resetsAt") == earlier.get("resetsAt")):
                        quota_delta.append({"bucket": bucket, "window": name,
                                            "percentage_points": window["usedPercent"] - earlier["usedPercent"]})
            row.update(total=total, last_rpc=last, delta=delta, quota=quota, quota_change=quota_delta)
            prior[thread] = row
            model_key = (row["role"], row["model"])
            model = models.setdefault(model_key, {"role": row["role"], "configured_model": row["model"],
                                                  "observed": {}, "turns": 0, "unknown": 0})
            model["turns"] += 1
            accumulate(model, delta)
            task_id = row["issue"] if row["issue"] is not None else row["task"]
            if task_id is not None:
                key = ("issue" if row["issue"] is not None else "task", task_id)
                group = tasks.setdefault(key, {"source": key[0], "task": task_id, "observed": {}, "unknown": 0})
                accumulate(group, delta)
        experiments = self.store.all("SELECT s.role,count(*) AS jobs FROM job JOIN session s ON s.id=job.session "
                                     "WHERE s.project=? GROUP BY s.role", (project,))
        return {"turns": rows, "tasks": list(tasks.values()), "models": list(models.values()),
                "experiment_counts": experiments,
                "experiment_evaluations": [{"job": row["job"], "delta": row["delta"]} for row in rows if row["job"]]}


def accumulate(group, delta):
    if "totalTokens" not in delta:
        group["unknown"] += 1
    for field, value in delta.items():
        group["observed"][field] = group["observed"].get(field, 0) + value
