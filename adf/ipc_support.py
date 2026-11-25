"""Atomic local JSON publication."""

import json
import os
from pathlib import Path
import tempfile


def atomic_json(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
