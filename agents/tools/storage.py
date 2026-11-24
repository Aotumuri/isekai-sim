"""Local, atomic JSON storage for the research tools."""

import fcntl
import json
import os
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "agents" / "research"
RUNTIME = ROOT / "agents" / "runtime"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data, *, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, prefix=".", delete=False) as handle:
        temp = Path(handle.name)
        try:
            handle.write((json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode())
            handle.flush()
            os.fsync(handle.fileno())
            if exclusive:
                os.link(temp, path)
            else:
                os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


@contextmanager
def lock(path, *, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield handle


def git(*args, strip=True):
    result = subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True)
    return result.stdout.strip() if strip else result.stdout


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
