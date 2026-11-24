"""Classification stored directly in GitHub issue labels and native close state."""

OPEN_STATES = {
    "proposed": ("ededed", "Scope or readiness still needs review"),
    "ready": ("0e8a16", "Ready to consider for assignment"),
    "in-progress": ("1d76db", "Work in progress"),
    "experimenting": ("5319e7", "Experiment in progress or awaiting its result"),
    "validating": ("006b75", "Verifying results or acceptance criteria"),
    "paused": ("fbca04", "Intentionally deferred or interrupted"),
    "blocked": ("b60205", "Waiting for a prerequisite"),
    "local-done": ("c5def5", "Local work complete; publication or closure pending"),
}
PRIORITIES = {
    "P1": ("b60205", "Highest priority: important prerequisite or urgent evidence"),
    "P2": ("d93f0b", "Normal priority: actionable research or development"),
    "P3": ("fef2c0", "Lower priority: revisit when evidence or capacity warrants"),
}
KINDS = {
    "research": ("bfd4f2", "Investigate behavior, evidence, or hypotheses"),
    "development": ("c2e0c6", "Explore or deliver a candidate product or framework change"),
    "validation": ("d4c5f9", "Verify acceptance criteria or an operational workflow"),
}
STATES = (*OPEN_STATES, "completed")
DIMENSIONS = {"status": OPEN_STATES, "priority": PRIORITIES, "kind": KINDS}
DEFINITIONS = [
    {"name": f"{axis}:{value.lower()}", "color": color, "description": description}
    for axis, values in DIMENSIONS.items() for value, (color, description) in values.items()
]


def label_names(issue):
    return [label["name"] if isinstance(label, dict) else label for label in issue.get("labels") or []]


def classification(issue):
    labels = label_names(issue)
    result = {}
    for axis, values in DIMENSIONS.items():
        found = [name for name in labels if name.lower().startswith(axis + ":")]
        allowed = {f"{axis}:{value.lower()}": value for value in values}
        if len(found) > 1 or any(name.lower() not in allowed for name in found):
            raise ValueError(f"Issue #{issue['number']} has invalid {axis} labels: {', '.join(found)}")
        result[axis] = allowed[found[0].lower()] if found else None
    if issue["state"] == "closed":
        result["status"] = "completed" if issue.get("state_reason") == "completed" else "closed"
    else:
        result["status"] = result["status"] or "proposed"
    return result


def replace_classification(labels, **changes):
    remaining = [label for label in labels
                 if label.lower().partition(":")[0] not in changes or ":" not in label]
    for axis, value in changes.items():
        if value is not None:
            if value not in DIMENSIONS[axis]:
                raise ValueError(f"Unknown {axis}: {value}")
            remaining.append(f"{axis}:{value.lower()}")
    return remaining
