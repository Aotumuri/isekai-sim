"""Project defaults and the effective settings authorized for a research run."""

import json

PRESETS = {
    "manual": {"jobs": 4, "turns": 8, "tokens": None, "timeout": 120, "recovery": "manual"},
    "controlled": {"jobs": 4, "turns": 8, "tokens": None, "timeout": 120, "recovery": "manual"},
    "autonomous": {"jobs": 0, "turns": 0, "tokens": 0, "timeout": 120, "recovery": "confirmed"},
}
MAXIMUM = {"jobs": 20, "turns": 40, "tokens": 1000000, "timeout": 86400}


def preset_config(name, overrides, *, require_tokens=True):
    if not isinstance(name, str) or name not in PRESETS:
        raise ValueError("プリセットは manual、controlled、autonomous から選択してください")
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
    config["github_review"] = "ask" if name == "manual" else "project-policy"
    return config


class Presets:
    def saved_preset(self, project):
        row = self.store.one("SELECT settings FROM research_preset WHERE project=?", (project,))
        return json.loads(row["settings"]) if row else None

    def research_preset(self, project, name=None, apply=False, jobs=None, turns=None, tokens=None, timeout=None,
                        recovery=None):
        self.project(project)
        if type(apply) is not bool:
            raise ValueError("適用の有無を指定してください")
        if name is None:
            if apply or any(value is not None for value in (jobs, turns, tokens, timeout, recovery)):
                raise ValueError("プリセット名を指定してください")
            return self.saved_preset(project)
        config = preset_config(name, dict(jobs=jobs, turns=turns, tokens=tokens, timeout=timeout, recovery=recovery),
                               require_tokens=apply)
        if apply:
            with self.store.db:
                self.store.db.execute("INSERT OR REPLACE INTO research_preset VALUES (?,?)",
                                      (project, json.dumps(config)))
        return config

    def research_settings(self, project, preset=None, recovery=None, **limits):
        saved = self.saved_preset(project)
        options = {key: limits.pop(key) for key in MAXIMUM if key in limits}
        if preset is None and not saved and recovery is None:
            # Internal legacy callers may omit the limit. Human clients send an explicit
            # null when no project default or token authorization has been supplied.
            if "tokens" in options and options["tokens"] is None:
                raise ValueError("観測トークン予算を明示するか、プロジェクトのプリセットを適用してください")
            return {**limits, **{key: value for key, value in options.items() if value is not None}}
        name = preset or (saved["name"] if saved else "controlled")
        overrides = ({key: saved[key] for key in (*MAXIMUM, "recovery")}
                     if saved and saved["name"] == name else {})
        overrides.update({key: value for key, value in options.items() if value is not None})
        if recovery is not None:
            overrides["recovery"] = recovery
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
