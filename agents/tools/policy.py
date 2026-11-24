"""Repository policy and shared execution generation."""

import tomllib
import uuid

from storage import ROOT, RUNTIME, now, read, write

CONTROL = RUNTIME / "control.json"
OWNER = RUNTIME / "developer.json"
LOCK = RUNTIME / "state.lock"


def config():
    path = ROOT / "agents/config.toml"
    with path.open("rb") as handle:
        return tomllib.load(handle)


def permit(section, operation, approved=False, settings=None):
    settings = config() if settings is None else settings
    values = settings
    for name in section.split("."):
        values = values.get(name, {})
    permission = values.get(operation, "deny")
    if permission == "allow" or (permission == "ask" and approved):
        return
    if permission == "ask":
        raise ValueError(f"{section}.{operation} requires explicit owner approval")
    raise ValueError(f"{section}.{operation} is denied by repository policy")


def control():
    return read(CONTROL) if CONTROL.exists() else {"mode": "running", "generation": "initial"}


def owner():
    return read(OWNER)["id"] if OWNER.exists() else None


def new_generation(mode, reason, **details):
    value = {"mode": mode, "generation": uuid.uuid4().hex, "reason": reason,
             "updated_at": now(), **details}
    write(CONTROL, value)
    return value


def require_running():
    mode = control()["mode"]
    if mode != "running":
        raise ValueError(f"Research is {mode}; explicit resume required")


def auto_resume():
    return config().get("execution", {}).get("auto_resume") is True


def wake_scope(job, delivery):
    current = control()
    target = delivery.get("thread")
    if not target or target != owner():
        return None, None
    generation = delivery.get("generation")
    if current["mode"] == "running" and generation == current["generation"]:
        if delivery.get("acceptance_probe") is True or auto_resume():
            return "research", generation
    if (current["mode"] == "stopping" and job in current["jobs"]
            and generation == current["prior_generation"] and not delivery.get("acceptance_probe")
            and auto_resume()):
        return "shutdown", current["generation"]
    return None, None
