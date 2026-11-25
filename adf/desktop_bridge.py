"""Translate the macOS UI's private stdio stream to local daemon requests."""

from concurrent.futures import ThreadPoolExecutor
import json
import sys
import threading


def bridge(client):
    output = threading.Lock()

    def handle(frame):
        try:
            result = {"value": client.call(frame["action"], **frame["args"])}
        except (OSError, ValueError, TypeError, KeyError) as error:
            result = {"error": str(error)}
        with output:
            print(json.dumps({"id": frame["id"], **result}, ensure_ascii=False), flush=True)

    with ThreadPoolExecutor(max_workers=4) as workers:
        for line in sys.stdin:
            try:
                frame = json.loads(line)
                if isinstance(frame, dict) and isinstance(frame.get("id"), str):
                    workers.submit(handle, frame)
            except ValueError:
                continue
