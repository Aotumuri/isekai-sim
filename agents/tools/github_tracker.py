"""GitHub Issues tracker using the installed GitHub CLI."""

import hashlib
import json
import re
import subprocess

from issue_classification import DEFINITIONS, STATES, classification, label_names, replace_classification
from issue_checklist import check_tasks
from policy import config, permit
from storage import ROOT, RUNTIME, lock, read, write

MARKER = re.compile(r"\n\n<!-- research-meta: (\{[^\n]*\}) -->\s*\Z")
OPERATIONS = RUNTIME / "github-operations.json"


def body_with_metadata(text, metadata):
    # Encode angle brackets to keep metadata inside an HTML comment.
    encoded = json.dumps(metadata, ensure_ascii=False, sort_keys=True)
    return text + "\n\n<!-- research-meta: " + encoded.replace("<", "\\u003c").replace(">", "\\u003e") + " -->"


def split_body(issue):
    body = issue.get("body") or ""
    match = MARKER.search(body)
    if not match:
        return body, {}
    try:
        metadata = json.loads(match.group(1))
    except ValueError as error:
        raise ValueError(f"Issue #{issue.get('number', '?')} has invalid research-meta JSON") from error
    return body[:match.start()], metadata


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
        return {"number": issue["number"], "title": issue["title"], "url": issue["html_url"],
                **classification(issue), "state_reason": issue.get("state_reason"),
                "metadata": metadata, "labels": label_names(issue)}

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

    def create(self, title, text, origin, key, approved, *, parent=None, priority=None, kind=None):
        permit("tracker.github", "create_issue", approved, self.settings)
        if not title.strip() or not text.strip() or origin not in ("ai", "human") or not key:
            raise ValueError("Issue requires a title, description, provenance, and stable key")
        if origin == "ai" and not title.rstrip().endswith("[AI]"):
            title = title.rstrip() + " [AI]"
        metadata = {"key": key, "origin": origin, "created_by": "ai"}
        if parent:
            self.issue(parent)
            text += f"\n\nParent: #{parent}"
            metadata["parent"] = parent
        labels = replace_classification([], status="proposed", priority=priority, kind=kind)
        payload = {"title": title, "body": body_with_metadata(text, metadata), "labels": labels}
        def send():
            result = self.api("POST", "issues", payload)
            if set(label_names(result)) != set(labels):
                raise ValueError(f"Issue #{result['number']} created without the requested labels; reconcile on GitHub")
            return result

        return self.once("create", key,
                         lambda: next((i for i in self.issues() if split_body(i)[1].get("key") == key), None),
                         send)

    def setup_labels(self, approved):
        permit("tracker.github", "create_label", approved, self.settings)
        with lock(RUNTIME / "github.lock"):
            existing = {label["name"].casefold(): label for label in self.labels()}
            for definition in DEFINITIONS:
                label = existing.get(definition["name"])
                if label and any(label.get(field) != value for field, value in definition.items()):
                    raise ValueError(f"Existing GitHub label definition differs: {definition['name']}")
            return [existing[definition["name"]] if definition["name"] in existing
                    else self.api("POST", "labels", definition) for definition in DEFINITIONS]

    def labels(self):
        return self.api("GET", "labels?per_page=100", paginate=True)

    def patch_issue(self, issue, payload):
        if not payload:
            return issue
        result = self.api("PATCH", f"issues/{issue['number']}", payload)
        for field, value in payload.items():
            matches = (set(label_names(result)) == set(value) if field == "labels"
                       else result.get(field) == value)
            if not matches:
                raise ValueError(f"Issue #{issue['number']} update did not confirm {field}; reread before retry")
        return result

    def classify(self, number, approved, **changes):
        permit("tracker.github", "update_issue", approved, self.settings)
        if changes.keys() - {"priority", "kind"}:
            raise ValueError("Use progress to change status")
        with lock(RUNTIME / "github.lock"):
            issue = self.issue(number)
            before = label_names(issue)
            labels = replace_classification(before, **changes)
            classification({**issue, "labels": labels})
            return self.patch_issue(issue, {"labels": labels} if set(labels) != set(before) else {})

    def candidates(self):
        issues = {issue["number"]: issue for issue in self.issues()}
        candidates = []
        for issue in issues.values():
            item = self.summary(issue)
            if item["status"] != "ready" and not (item["status"] == "proposed" and item["priority"] == "P1"):
                continue
            dependencies = self.api("GET", f"issues/{item['number']}/dependencies/blocked_by?per_page=100",
                                    paginate=True)
            blockers = {dep["html_url"] for dep in dependencies
                        if classification(dep)["status"] not in ("completed", "local-done")}
            references = item["metadata"].get("references", {})
            numbers = references.get("blocked-by", []) if isinstance(references, dict) else None
            if not isinstance(numbers, list) or any(type(number) is not int or number < 1 for number in numbers):
                raise ValueError(f"Issue #{item['number']} has invalid hard dependency references")
            for number in numbers:
                dependency = issues.get(number)
                if dependency is None or classification(dependency)["status"] not in ("completed", "local-done"):
                    blockers.add(f"#{number}")
            candidates.append({**item, "unresolved_dependencies": sorted(blockers),
                               "eligible": item["status"] == "ready" and not blockers})
        return sorted(candidates, key=lambda item: (item["priority"] or "P4", item["number"]))

    def progress(self, number, status, approved, published=False, tasks=()):
        permit("tracker.github", "update_issue", approved, self.settings)
        if status not in STATES:
            raise ValueError(f"Unknown task status: {status}")
        with lock(RUNTIME / "github.lock"):
            return self._progress(number, status, approved, published, tasks)

    def _progress(self, number, status, approved, published, tasks):
        issue = self.issue(number)
        text, _ = split_body(issue)
        if issue["state"] == "closed":
            if status == "completed" and issue.get("state_reason") == "completed" and check_tasks(text, tasks) == text:
                return issue
            raise ValueError("Issue is already closed; use checklist for historical corrections")
        payload = {}
        if status == "completed":
            permit("tracker.github", "close_issue", approved, self.settings)
            close_on = self.options.get("close_on", "published")
            if close_on not in ("published", "local") or (close_on == "published" and not published):
                raise ValueError("Closure requires the configured published completion evidence; use local-done")
            payload.update(state="closed", state_reason="completed")
        checked = check_tasks(text, tasks)
        if checked != text:
            payload["body"] = checked + issue["body"][len(text):]
        labels = label_names(issue)
        desired = replace_classification(labels, status=None if status == "completed" else status)
        if set(desired) != set(labels):
            payload["labels"] = desired
        classification({**issue, **payload})
        return self.patch_issue(issue, payload)

    def checklist(self, number, tasks, approved, result_comment=None):
        permit("tracker.github", "update_issue", approved, self.settings)
        if not tasks:
            raise ValueError("Checklist requires at least one --check-task")
        endpoint = f"issues/{number}"
        with lock(RUNTIME / "github.lock"):
            issue = self.issue(number)
            text, _ = split_body(issue)
            checked = check_tasks(text, tasks)
            if result_comment is not None:
                comments = self.api("GET", endpoint + "/comments?per_page=100", paginate=True)
                result = next((c for c in comments if c["id"] == result_comment), None)
                if result is None:
                    raise ValueError(f"Result comment {result_comment} not found on issue #{number}")
                link = f"[試験結果]({result['html_url']})"
                if link not in checked.splitlines():
                    checked = checked.rstrip() + f"\n\n{link}"
            if checked == text:
                return issue
            return self.api("PATCH", endpoint, {"body": checked + issue["body"][len(text):]})

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
