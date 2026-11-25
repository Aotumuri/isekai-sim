"""Owner-only, local filesystem IPC shared by desktop and CLI clients."""

import asyncio
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from .service import Service
from .store import Store, owner_lock, private_dir
from .codex import RuntimeError

MAX_REQUEST = 65536


def write(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def mailbox(home):
    return private_dir(home / "ipc")


class Client:
    def __init__(self, home):
        self.home = private_dir(home)
        self.box = mailbox(self.home)

    def launch(self):
        try:
            with owner_lock(self.home):
                subprocess.Popen([sys.executable, "-I", str(Path(__file__).with_name("launcher.py")), "daemon"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 cwd=Path.home(), start_new_session=True)
        except BlockingIOError:
            pass

    def call(self, action, *, launch=True, timeout=45, **args):
        if launch:
            self.launch()
        key = uuid.uuid4().hex
        request = self.box / f"{key}.request"
        response = self.box / f"{key}.response"
        payload = {"action": action, "args": args, "deadline": time.time() + timeout}
        if len(json.dumps(payload).encode()) > MAX_REQUEST:
            raise ValueError("指示または設定が長すぎます")
        write(request, payload)
        try:
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                if response.exists():
                    result = json.loads(response.read_text())
                    if "error" in result:
                        raise ValueError(result["error"])
                    return result["value"]
                time.sleep(0.08)
            raise ValueError("ADF の応答期限を過ぎました。履歴を確認してください")
        finally:
            request.unlink(missing_ok=True)
            response.unlink(missing_ok=True)


async def handle(service, path):
    try:
        with path.open("rb") as handle:
            data = json.loads(handle.read(MAX_REQUEST + 1))
        path.unlink()
    except (OSError, ValueError):
        path.unlink(missing_ok=True)
        return
    if not isinstance(data, dict) or data.get("deadline", 0) < time.time():
        return
    try:
        value = {"value": await service.dispatch(data["action"], data["args"])}
    except (ValueError, RuntimeError) as error:
        value = {"error": str(error)}
    except (OSError, TimeoutError, TypeError, KeyError) as error:
        value = {"error": f"ADF の操作に失敗しました ({type(error).__name__})"}
    write(path.with_suffix(".response"), value)


async def serve(home, binary):
    box = mailbox(home)
    with owner_lock(home) as lock:
        store = Store(home)
        service = Service(store, binary, lease=lock.fileno())
        store.recover()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, lambda: service.background(service.stop_all(immediate=True)))
        try:
            await receive(service, box)
        finally:
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)
            await service.close()
            store.db.close()


async def receive(service, box):
    inflight = {}
    cleanup = 0
    while not service.is_stopped() or inflight:
        for path in box.glob("*.request"):
            if (path not in inflight and re.fullmatch(r"[a-f0-9]{32}\.request", path.name)
                    and len(inflight) < 32):
                inflight[path] = asyncio.create_task(handle(service, path))
        for path, task in list(inflight.items()):
            if task.done():
                task.result()
                del inflight[path]
        if time.monotonic() >= cleanup:
            cleanup = time.monotonic() + 60
            for response in box.glob("*.response"):
                try:
                    if response.stat().st_mtime < time.time() - 300:
                        response.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass
        await asyncio.sleep(0.15)
