"""Atomic publication and bounded reads for the local request inbox."""

import json
import os
import stat
from pathlib import Path
import tempfile
from uuid import UUID

MAX_REQUEST = 128 * 1024


def atomic_json(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def read_request(name, *, dir_fd):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("request must be a regular file")
        payload = handle.read(MAX_REQUEST + 1)
    if len(payload) > MAX_REQUEST:
        raise ValueError("request too large")
    return json.loads(payload)


def is_id(value):
    try:
        return str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False
