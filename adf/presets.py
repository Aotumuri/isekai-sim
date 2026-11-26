"""Project defaults and the effective settings authorized for a research run."""

import json

PRESETS = {
    "manual": {"jobs": 4, "turns": 8, "tokens": None, "timeout": 120, "recovery": "manual", "empty_queue": "stop"},
    "controlled": {"jobs": 4, "turns": 8, "tokens": None, "timeout": 120, "recovery": "manual", "empty_queue": "stop"},
    "autonomous": {"jobs": 0, "turns": 0, "tokens": 0, "timeout": 120, "recovery": "confirmed", "empty_queue": "wait"},
    "research-autonomous": {"jobs": 4, "turns": 8, "tokens": None, "timeout": 120,
                            "recovery": "confirmed", "empty_queue": "discover"},
}
MAXIMUM = {"jobs": 20, "turns": 40, "tokens": 1000000, "timeout": 86400}


def preset_config(name, overrides, *, require_tokens=True):
    if not isinstance(name, str) or name not in PRESETS:
        raise ValueError("プリセットは manual、controlled、autonomous、research-autonomous から選択してください")
    config = {"name": name, **PRESETS[name], **{key: value for key, value in overrides.items() if value is not None}}
    for key, maximum in MAXIMUM.items():
        value = config[key]
        if key == "tokens" and value is None and not require_tokens:
            continue
        minimum = 1 if key == "timeout" else 0
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"{key} は {minimum}〜{maximum} の範囲で明示してください（上限の 0 は無制限）")
    if config["recovery"] not in ("manual", "confirmed") or (name == "manual" and config["recovery"] != "manual"):
        raise ValueError("Manual では利用枠回復後に手動で再開します")
    if config["empty_queue"] not in {"stop", "wait", "discover"} or (
            config["empty_queue"] == "discover" and name != "research-autonomous"):
        raise ValueError("空の課題キューの動作を確認してください")
    config.setdefault("discovery_issue", "ask")
    if config["discovery_issue"] not in {"ask", "policy"} or (
            config["discovery_issue"] == "policy" and name != "research-autonomous"):
        raise ValueError("研究候補の起票条件を確認してください")
    config["github_review"] = "ask" if name == "manual" else "project-policy"
    return config


class Presets:
    def saved_preset(self, project):
        row = self.store.one("SELECT settings FROM research_preset WHERE project=?", (project,))
        return json.loads(row["settings"]) if row else None

    def research_preset(self, project, name=None, apply=False, jobs=None, turns=None, tokens=None, timeout=None,
                        recovery=None, empty_queue=None, discovery_issue=None):
        self.project(project)
        if type(apply) is not bool:
            raise ValueError("適用の有無を指定してください")
        if name is None:
            if apply or any(value is not None for value in (jobs, turns, tokens, timeout, recovery, empty_queue, discovery_issue)):
                raise ValueError("プリセット名を指定してください")
            return self.saved_preset(project)
        config = preset_config(name, dict(jobs=jobs, turns=turns, tokens=tokens, timeout=timeout, recovery=recovery,
                                         empty_queue=empty_queue, discovery_issue=discovery_issue),
                               require_tokens=apply)
        if apply:
            with self.store.db:
                self.store.db.execute("INSERT OR REPLACE INTO research_preset VALUES (?,?)",
                                      (project, json.dumps(config)))
        return config

    def research_settings(self, project, preset=None, recovery=None, empty_queue=None, discovery_issue=None, **limits):
        saved = self.saved_preset(project)
        options = {key: limits.pop(key) for key in MAXIMUM if key in limits}
        if preset is None and not saved and recovery is None and empty_queue is None and discovery_issue is None:
            # Internal legacy callers may omit the limit. Human clients send an explicit
            # null when no project default or token authorization has been supplied.
            if "tokens" in options and options["tokens"] is None:
                raise ValueError("観測トークン予算を明示するか、プロジェクトのプリセットを適用してください")
            return {**limits, **{key: value for key, value in options.items() if value is not None}}
        name = preset or (saved["name"] if saved else "controlled")
        overrides = ({key: saved[key] for key in (*MAXIMUM, "recovery", "empty_queue", "discovery_issue") if key in saved}
                     if saved and saved["name"] == name else {})
        overrides.update({key: value for key, value in options.items() if value is not None})
        if recovery is not None:
            overrides["recovery"] = recovery
        if empty_queue is not None:
            overrides["empty_queue"] = empty_queue
        if discovery_issue is not None:
            overrides["discovery_issue"] = discovery_issue
        config = preset_config(name, overrides)
        return {**limits, **{key: config[key] for key in MAXIMUM}, "preset_settings": config}

    def tracker_requires_review(self, draft, guard):
        preset = self.saved_preset(draft["project"]) or {}
        if preset.get("github_review") == "ask":
            return True
        if not guard:
            return False
        run = self.store.one("SELECT scope FROM research_run WHERE session=? AND generation=?",
                             (guard["session"], guard["generation"]))
        return bool(run and json.loads(run["scope"]).get("preset", {}).get("github_review") == "ask")
