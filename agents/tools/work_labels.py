"""Work labels managed by the GitHub tracker."""

WORK_LABELS = {
    "work:implementing": ("1d76db", "Implementation, fixes, or validation in progress"),
    "work:implementation-paused": ("bfdadc", "Implementation or validation paused or blocked"),
    "work:experimenting": ("0e8a16", "Experiment running"),
    "work:experiment-paused": ("c2e0c6", "Experiment phase paused or blocked"),
    "work:unknown": ("ededed", "Work has not started or its phase is unknown"),
}
ACTIVE = {
    "in-progress": "work:implementing",
    "validating": "work:implementing",
    "experimenting": "work:experimenting",
}
PAUSED = {
    "work:implementing": "work:implementation-paused",
    "work:implementation-paused": "work:implementation-paused",
    "work:experimenting": "work:experiment-paused",
    "work:experiment-paused": "work:experiment-paused",
}


def label_names(issue):
    return [label["name"] if isinstance(label, dict) else label for label in issue.get("labels") or []]


def update_work_labels(labels, status, previous=None):
    managed = set(labels) & WORK_LABELS.keys()
    remaining = [label for label in labels if label not in WORK_LABELS]
    if status in ("local-done", "completed"):
        return remaining
    label = ACTIVE.get(status, "work:unknown")
    if status in ("paused", "blocked"):
        previous_label = ACTIVE.get(previous)
        if previous_label is None and len(managed) == 1:
            previous_label = next(iter(managed))
        label = PAUSED.get(previous_label, "work:unknown")
    return [*remaining, label]
