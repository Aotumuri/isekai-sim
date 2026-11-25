"""Owner-only, local filesystem IPC shared by desktop and CLI clients."""

import asyncio
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

from .service import Service
from .store import Store, owner_lock, private_dir
from .codex import RuntimeError
from .ipc_support import atomic_json as write

MAX_REQUEST = 65536


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


def read_request(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("IPC 要求には通常ファイルを使用してください")
        raw = handle.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("IPC 要求のサイズが上限を超えています")
    return json.loads(raw)


def validate_request(data):
    if (not isinstance(data, dict) or set(data) != {"action", "args", "deadline"}
            or not isinstance(data["action"], str) or not isinstance(data["args"], dict)
            or type(data["deadline"]) not in (int, float)
            or not math.isfinite(data["deadline"])):
        raise ValueError("IPC 要求の形式が不正です")


async def handle(service, path):
    try:
        try:
            data = read_request(path)
        finally:
            path.unlink(missing_ok=True)
        validate_request(data)
        if data["deadline"] < time.time():
            return
        value = {"value": await service.dispatch(data["action"], data["args"])}
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        value = {"error": "IPC の JSON が不正です"}
    except (ValueError, RuntimeError) as error:
        value = {"error": str(error)}
    except Exception as error:
        # One request is never allowed to terminate the service. Do not emit
        # payloads, local paths or authenticated subprocess output in diagnostics.
        logging.warning("ADF IPC operation failed (%s)", type(error).__name__)
        value = {"error": f"ADF の操作に失敗しました ({type(error).__name__})"}
    try:
        write(path.with_suffix(".response"), value)
    except Exception as error:
        logging.warning("ADF IPC response failed (%s)", type(error).__name__)


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
                except OSError:
                    pass
        await asyncio.sleep(0.15)
