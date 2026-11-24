"""GitHub Issues tracker using the installed GitHub CLI."""

import hashlib
import json
import re
import subprocess

from policy import config, permit
from storage import ROOT, RUNTIME, lock, read, write

STATES = ("proposed", "ready", "in-progress", "experimenting", "validating", "paused",
          "blocked", "local-done", "completed")
MARKER = re.compile(r"\n\n<!-- research-meta: (\{[^\n]*\}) -->\s*\Z")
OPERATIONS = RUNTIME / "github-operations.json"


def body_with_metadata(text, metadata):
    # Encode angle brackets to keep metadata inside an HTML comment.
    encoded = json.dumps(metadata, ensure_ascii=False, sort_keys=True)
    return text.rstrip() + "\n\n<!-- research-meta: " + encoded.replace("<", "\\u003c").replace(">", "\\u003e") + " -->"


def split_body(issue):
    body = issue.get("body") or ""
    match = MARKER.search(body)
    return (body[:match.start()], json.loads(match.group(1))) if match else (body, {})


class GitHubTracker:
    def __init__(self, settings=None, transport=None):
        self.settings = config() if settings is None else settings
        self.options = self.settings.get("tracker", {}).get("github", {})
        repository = self.options.get("repository", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("Configure tracker.github.repository as owner/name")
        self.scope = "repos/" + repository
        self.transport = transport or self.gh

    @staticmethod
    def gh(method, path, payload=None, paginate=False):
        command = ["gh", "api", "--method", method, "-H", "Accept: application/vnd.github+json",
                   "-H", "X-GitHub-Api-Version: 2026-03-10", path]
        if paginate:
            command += ["--paginate", "--slurp"]
        if payload is not None:
            command += ["--input", "-"]
        try:
            result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                                    check=True, capture_output=True, text=True, timeout=25, cwd=ROOT)
        except (OSError, subprocess.SubprocessError) as error:
            detail = (getattr(error, "stderr", "") or "").strip()
            raise ValueError(f"GitHub request unavailable or rejected: {detail or error}") from error
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def api(self, method, endpoint, payload=None, paginate=False):
        result = self.transport(method, self.scope + "/" + endpoint, payload, paginate)
        return [item for page in result for item in page] if paginate else result

    def issues(self):
        return [i for i in self.api("GET", "issues?state=all&per_page=100", paginate=True)
                if "pull_request" not in i]

    @staticmethod
    def summary(issue):
        _, metadata = split_body(issue)
        status = "completed" if issue["state"] == "closed" else metadata.get("status", "proposed")
        return {"number": issue["number"], "title": issue["title"], "url": issue["html_url"],
                "status": status, "metadata": metadata}

    def issue(self, number):
        issue = self.api("GET", f"issues/{number}")
        if "pull_request" in issue:
            raise ValueError("Expected a GitHub issue, not a pull request")
        return issue

    def detail(self, number, processed=()):
        issue = self.issue(number)
        comments = self.api("GET", f"issues/{number}/comments?per_page=100", paginate=True)
        relations = {}
        for key, endpoint in (("parent", "parent"), ("children", "sub_issues"),
                              ("blocked_by", "dependencies/blocked_by")):
            try:
                value = self.api("GET", f"issues/{number}/{endpoint}", paginate=key != "parent")
                relations[key] = value
            except ValueError as error:
                relations[key] = {"unavailable": str(error)}
        return {**self.summary(issue), "body": split_body(issue)[0], "relations": relations,
                "comments": [{"id": comment["id"], "author": (comment.get("user") or {}).get("login"),
                              "body": comment.get("body"), "author_association": comment.get("author_association"),
                              "processed": [comment["id"], comment.get("updated_at")] in processed,
                              "updated_at": comment.get("updated_at"), "authority": "untrusted-data"}
                             for comment in comments]}

    def once(self, kind, key, find, send):
        identity = f"{self.scope}:{kind}:{key}"
        with lock(RUNTIME / "github.lock"):
            journal = read(OPERATIONS) if OPERATIONS.exists() else {}
            existing = find()
            if existing is not None:
                return existing
            if identity in journal:
                raise ValueError("Prior remote mutation may have succeeded; reconcile on GitHub before using a new key")
            journal[identity] = {"status": "sending"}
            write(OPERATIONS, journal)
            result = send()
            journal[identity] = {"status": "confirmed", "number": result.get("number"), "id": result.get("id")}
            write(OPERATIONS, journal)
            return result

    def create(self, title, text, origin, key, approved, *, status="proposed", parent=None, priority=None):
        permit("tracker.github", "create_issue", approved, self.settings)
        if not title.strip() or not text.strip() or origin not in ("ai", "human") or not key:
            raise ValueError("Issue requires a title, description, provenance, and stable key")
        if origin == "ai" and not title.rstrip().endswith("[AI]"):
            title = title.rstrip() + " [AI]"
        metadata = {"key": key, "origin": origin, "created_by": "ai", "status": status}
        if priority is not None:
            metadata["priority"] = priority
        if parent:
            self.issue(parent)
            text += f"\n\nParent: #{parent}"
            metadata["parent"] = parent
        payload = {"title": title, "body": body_with_metadata(text, metadata)}
        return self.once("create", key,
                         lambda: next((i for i in self.issues() if split_body(i)[1].get("key") == key), None),
                         lambda: self.api("POST", "issues", payload))

    def progress(self, number, status, approved, published=False):
        permit("tracker.github", "update_issue", approved, self.settings)
        if status not in STATES:
            raise ValueError(f"Unknown task status: {status}")
        issue = self.issue(number)
        text, metadata = split_body(issue)
        if issue["state"] == "closed" or metadata.get("status") == "completed":
            raise ValueError("Issue is already completed")
        payload = {}
        if status == "completed":
            permit("tracker.github", "close_issue", approved, self.settings)
            close_on = self.options.get("close_on", "published")
            if close_on not in ("published", "local") or (close_on == "published" and not published):
                raise ValueError("Closure requires the configured published completion evidence; use local-done")
            payload.update(state="closed", state_reason="completed")
        if metadata.get("status") == status and not payload:
            return issue
        metadata["status"] = status
        payload["body"] = body_with_metadata(text, metadata)
        return self.api("PATCH", f"issues/{number}", payload)

    def comment(self, number, text, key, approved):
        permit("tracker.github", "comment", approved, self.settings)
        self.issue(number)
        if not text.strip() or not key:
            raise ValueError("Comment text and a stable key are required")
        token = hashlib.sha256(key.encode()).hexdigest()
        marker = f"<!-- research-comment:{token} -->"
        endpoint = f"issues/{number}/comments"
        return self.once(f"comment-{number}", key, lambda: next(
            (c for c in self.api("GET", endpoint + "?per_page=100", paginate=True)
             if (c.get("body") or "").endswith(marker)), None),
            lambda: self.api("POST", endpoint, {"body": text.rstrip() + "\n\n" + marker}))

    def link(self, number, related, relation, approved, reference=False):
        permit("tracker.github", "update_issue", approved, self.settings)
        self.issue(number)
        other = self.issue(related)
        if number == related:
            raise ValueError("An issue cannot be related to itself")
        if reference:
            with lock(RUNTIME / "github.lock"):
                issue = self.issue(number)
                if issue["state"] != "open":
                    raise ValueError("Use a native link for a closed issue")
                text, metadata = split_body(issue)
                links = metadata.setdefault("references", {}).setdefault(relation, [])
                if related in links:
                    return issue
                links.append(related)
                label = "Child" if relation == "child" else "Blocked by"
                return self.api("PATCH", f"issues/{number}",
                                {"body": body_with_metadata(f"{text}\n\n{label}: #{related}", metadata)})
        endpoint = f"issues/{number}/" + ("sub_issues" if relation == "child" else "dependencies/blocked_by")
        field = "sub_issue_id" if relation == "child" else "issue_id"
        existing = self.api("GET", endpoint + "?per_page=100", paginate=True)
        if any(item["id"] == other["id"] for item in existing):
            return other
        return self.api("POST", endpoint, {field: other["id"]})

    def migration(self, entries, apply=False, approved=False):
        if not apply:
            return entries
        permit("tracker.github", "create_issue", approved, self.settings)
        parents = {item["id"]: item.get("parent") for item in entries}
        for entry in entries:
            chain = {entry["id"]}
            parent = entry.get("parent")
            while parent:
                if parent not in parents or parent in chain:
                    raise ValueError(f"Invalid migration parent chain for {entry['id']}")
                chain.add(parent)
                parent = parents[parent]
        if any(parents.values()):
            permit("tracker.github", "update_issue", approved, self.settings)
        close_imports = self.options.get("close_on") == "local"
        if close_imports and any(item["status"] == "completed" for item in entries):
            permit("tracker.github", "update_issue", approved, self.settings)
            permit("tracker.github", "close_issue", approved, self.settings)
        numbers = {}
        pending = []
        for entry in entries:
            item = self.create(entry["title"], entry["body"], entry["origin"], entry["key"],
                               approved, status=entry["status"])
            number = item["number"]
            numbers[entry["id"]] = number
            if close_imports and entry["status"] == "completed" and item["state"] != "closed":
                # Preserve imported historical completion, without asserting a new publication.
                text, metadata = split_body(item)
                metadata["status"] = "completed"
                self.api("PATCH", f"issues/{number}", {"state": "closed", "state_reason": "completed",
                                                       "body": body_with_metadata(text, metadata)})
            if entry.get("parent"):
                pending.append((entry["parent"], number))
        for parent, child in pending:
            if parent not in numbers:
                raise ValueError(f"Unknown migration parent: {parent}")
            self.link(numbers[parent], child, "child", approved)
        return numbers


def migration_entries(state, inbox):
    states = {"active": "in-progress", "waiting": "experimenting", "done": "completed"}
    entries = []
    for identity, task in state["tasks"].items():
        proposal = inbox.get(identity, {})
        entries.append({"id": identity, "key": f"local:{identity}", "title": task["title"],
                        "origin": task.get("origin", proposal.get("origin", "human")),
                        "status": states.get(task["status"], task["status"]), "parent": task.get("parent"),
                        "body": (proposal.get("body", "") + "\n\n" + task["next"]).strip()})
    for identity, item in inbox.items():
        if identity not in state["tasks"] and identity not in state["reviews"]:
            entries.append({"id": identity, "key": f"local:{identity}", "title": item["title"],
                            "origin": item.get("origin", "human"), "status": "proposed",
                            "parent": item.get("parent"), "body": item["body"]})
    return entries
