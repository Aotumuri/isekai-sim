"""Inventory, migrate, and verify the one-time GitHub tracker redesign."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
from urllib.parse import quote

from github_tracker import GitHubTracker, body_with_metadata, split_body
from issue_classification import DEFINITIONS, OPEN_STATES, classification, label_names, replace_classification
from policy import LOCK, owner, permit
from storage import RUNTIME, lock, now, read, write

LEGACY_LABELS = {
    "work:implementing", "work:implementation-paused", "work:experimenting",
    "work:experiment-paused", "work:unknown",
}
COLLECTIONS = ("comments", "sub_issues", "dependencies/blocked_by", "dependencies/blocking")


def index(items):
    return {str(item["number"]): item for item in items}


def issue_details(tracker, number):
    issue = tracker.issue(number)
    details = {"issue": issue}
    for collection in COLLECTIONS:
        rows = tracker.api("GET", f"issues/{number}/{collection}?per_page=100", paginate=True)
        details[collection] = rows if collection == "comments" else relation_ids(rows)
    try:
        parent = tracker.api("GET", f"issues/{number}/parent")
    except ValueError as error:
        if "HTTP 404" not in str(error):
            raise
        parent = None
    details["parent"] = relation_ids([parent]) if parent else []
    if "comments" in issue and len(details["comments"]) != issue["comments"]:
        raise ValueError(f"Issue #{number} comments changed during inventory; retry")
    return details


def relation_ids(rows):
    return sorted(({"id": row["id"], "url": row["html_url"]} for row in rows), key=lambda row: row["id"])


def inventory(tracker):
    rows = tracker.api("GET", "issues?state=all&per_page=100", paginate=True)
    issues = index(row for row in rows if "pull_request" not in row)
    with ThreadPoolExecutor(max_workers=6) as pool:
        details = dict(zip(issues, pool.map(lambda number: issue_details(tracker, number), issues)))
    if any(issue_fingerprint(item["issue"]) != issue_fingerprint(issues[number])
           for number, item in details.items()):
        raise ValueError("Issues changed during inventory; retry")
    return {"repository": tracker.scope, "captured_at": now(), "labels": tracker.labels(),
            "issues": details, "pull_requests": index(row for row in rows if "pull_request" in row)}


def issue_fingerprint(issue):
    return (stable_issue_fields(issue), issue.get("updated_at"), issue.get("body"),
            frozenset(label_names(issue)))


def stable_issue_fields(issue):
    return tuple(issue.get(field) for field in
                 ("id", "title", "state", "state_reason", "comments", "assignees", "milestone"))


def desired_issue(issue, kind):
    number = issue["number"]
    text, metadata = split_body(issue)
    status = metadata.pop("status", None)
    priority = metadata.pop("priority", None)
    if issue["state"] == "closed":
        if status is not None and (status != "completed" or issue.get("state_reason") != "completed"):
            raise ValueError(f"Issue #{number} has conflicting historical and native close states")
        status = None
    elif status is None:
        status = "proposed"
    elif status not in OPEN_STATES:
        raise ValueError(f"Issue #{number} has unsupported historical status: {status}")
    before = label_names(issue)
    labels = replace_classification([name for name in before if name.lower() not in LEGACY_LABELS],
                                    status=status, priority=priority, kind=kind)
    existing_managed = {name for name in before if name.lower().partition(":")[0] in
                        ("status", "priority", "kind") and ":" in name}
    if existing_managed - set(labels):
        raise ValueError(f"Issue #{number} has conflicting pre-existing classification")
    body = body_with_metadata(text, metadata) if split_body(issue)[1] != metadata else issue.get("body")
    expected = {**issue, "body": body, "labels": labels}
    classification(expected)
    return expected


def plan(before, kinds):
    if extra := kinds.keys() - before["issues"].keys():
        raise ValueError(f"Unknown issue numbers in category mapping: {', '.join(sorted(extra))}")
    updates = {number: desired_issue(details["issue"], kinds.get(number))
               for number, details in before["issues"].items()}
    duplicates = [number for number, details in before["pull_requests"].items()
                  if LEGACY_LABELS.intersection(name.lower() for name in label_names(details))]
    if duplicates:
        raise ValueError(f"Legacy labels still used by pull requests: {', '.join(duplicates)}")
    labels = label_definitions(before["labels"])
    return {"repository": before["repository"], "kinds": kinds,
            "create": [d for d in DEFINITIONS if d["name"] not in labels],
            "delete": sorted(LEGACY_LABELS & labels.keys()),
            "issues": {number: classification(issue) for number, issue in updates.items()}}


def label_definitions(labels):
    existing = {label["name"].casefold(): label for label in labels}
    for expected in DEFINITIONS:
        item = existing.get(expected["name"])
        if item and any(item.get(field) != value for field, value in expected.items()):
            raise ValueError(f"Existing label conflicts with migration: {expected['name']}")
    return existing


def issue_payload(before, expected):
    payload = {}
    if before.get("body") != expected.get("body"):
        payload["body"] = expected["body"]
    if set(label_names(before)) != set(label_names(expected)):
        payload["labels"] = label_names(expected)
    return payload


def check_snapshot(tracker, before, expected):
    current = index(tracker.issues())
    if current.keys() != before["issues"].keys():
        raise ValueError("The set of issues changed since dry run; capture a fresh inventory")
    for number, issue in current.items():
        original = before["issues"][number]["issue"]
        unchanged = issue_fingerprint(issue) == issue_fingerprint(original)
        target = expected[number]
        existing_labels = set(label_names(issue))
        original_labels = set(label_names(original))
        target_labels = set(label_names(target))
        matches_migration = (issue.get("body") in (original.get("body"), target.get("body"))
                             and existing_labels in (original_labels, target_labels)
                             and (issue.get("body") != original.get("body") or existing_labels != original_labels)
                             and stable_issue_fields(issue) == stable_issue_fields(original))
        if not (unchanged or matches_migration):
            raise ValueError(f"Issue #{number} changed since dry run; reconcile before writing")
    return current


def preserved_fields(issue):
    return {field: value for field, value in issue.items()
            if field not in ("updated_at", "body", "labels")}


def apply(tracker, before, approved_plan, approved):
    if not approved:
        raise ValueError("Migration requires explicit owner approval for the complete batch")
    if before["repository"] != tracker.scope or plan(before, approved_plan["kinds"]) != approved_plan:
        raise ValueError("Migration plan does not match the backup or configured repository")
    for operation in ("create_label", "update_issue", "delete_label"):
        permit("tracker.github", operation, approved, tracker.settings)
    expected = {n: desired_issue(d["issue"], approved_plan["kinds"].get(n))
                for n, d in before["issues"].items()}
    with lock(LOCK), lock(RUNTIME / "github.lock"):
        if active_owner := owner():
            raise ValueError(f"Developer ownership held by {active_owner}")
        current = check_snapshot(tracker, before, expected)
        existing = label_definitions(tracker.labels())
        for definition in DEFINITIONS:
            if definition["name"] not in existing:
                if definition not in approved_plan["create"]:
                    raise ValueError(f"Previously existing label disappeared: {definition['name']}")
                tracker.api("POST", "labels", definition)
        for number in sorted(current, key=int):
            issue = tracker.issue(number)
            if issue_fingerprint(issue) != issue_fingerprint(current[number]):
                raise ValueError(f"Issue #{number} changed during migration; reread before retry")
            tracker.patch_issue(issue, issue_payload(issue, expected[number]))
        # GitHub label deletion is repository-wide, including pull requests.
        rows = tracker.api("GET", "issues?state=all&per_page=100", paginate=True)
        for name in approved_plan["delete"]:
            affected = [row["number"] for row in rows if name in {label.lower() for label in label_names(row)}]
            if affected:
                raise ValueError(f"Cannot delete {name}; still applied to {affected}")
            if name in existing:
                tracker.api("DELETE", "labels/" + quote(name, safe=""))


def verify(tracker, before, approved_plan, after):
    if before["repository"] != tracker.scope or after["repository"] != tracker.scope:
        raise ValueError("Inventory repository does not match the configured tracker")
    if before["issues"].keys() != after["issues"].keys():
        raise ValueError("The issue set differs from the pre-migration inventory")
    if {n: label_names(row) for n, row in before["pull_requests"].items()} != {
            n: label_names(row) for n, row in after["pull_requests"].items()}:
        raise ValueError("Pull request inventory or labels changed during migration")
    definitions = label_definitions(after["labels"])
    old = {label["name"]: label for label in before["labels"] if label["name"] not in approved_plan["delete"]}
    if (any(d["name"] not in definitions for d in DEFINITIONS)
            or LEGACY_LABELS & definitions.keys()
            or any(definitions.get(name.casefold()) != label for name, label in old.items())):
        raise ValueError("Unexpected repository label definitions after migration")
    verified = {}
    for number, original in before["issues"].items():
        details = after["issues"][number]
        issue = details["issue"]
        expected = desired_issue(original["issue"], approved_plan["kinds"].get(number))
        if (issue_payload(issue, expected) or preserved_fields(issue) != preserved_fields(original["issue"])
                or any(details[field] != original[field] for field in (*COLLECTIONS, "parent"))):
            raise ValueError(f"Issue #{number} differs from the expected migration")
        summary = tracker.summary(issue)
        verified[number] = {key: summary[key] for key in ("status", "priority", "kind", "state_reason")}
    return verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inventory", "plan", "apply", "verify"))
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--kinds", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--approved", action="store_true")
    args = parser.parse_args()
    tracker = GitHubTracker()
    if args.action == "inventory":
        result = inventory(tracker)
        write(args.before, result, exclusive=True)
        print(f"Saved {len(result['issues'])} issues")
        return
    before = read(args.before)
    if before["repository"] != tracker.scope:
        raise ValueError("Inventory repository does not match the configured tracker")
    if args.plan is None:
        parser.error("--plan is required")
    if args.action == "plan":
        result = plan(before, read(args.kinds) if args.kinds else {})
        write(args.plan, result, exclusive=True)
    elif args.action == "apply":
        apply(tracker, before, read(args.plan), args.approved)
        return
    else:
        if args.after is None:
            parser.error("--after is required for verify")
        after = inventory(tracker)
        write(args.after, after, exclusive=True)
        result = verify(tracker, before, read(args.plan), after)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
