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
from .store import DESKTOP_TRANSFER, Store, owner_lock, private_dir
from .codex import RuntimeError
from .ipc_support import atomic_json as write

MAX_REQUEST = 65536
EPOCH = "core-epoch.json"


def mailbox(home):
    return private_dir(home / "ipc")


class Client:
    def __init__(self, home):
        self.home = private_dir(home)
        self.box = mailbox(self.home)

    def launch(self):
        try:
            with owner_lock(self.home):
                fd = os.open(self.home / "supervisor.log",
                             os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "ab") as log:
                    return subprocess.Popen(
                        [sys.executable, "-I", str(Path(__file__).with_name("launcher.py")), "daemon"],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        cwd=Path(__file__).resolve().parent.parent, start_new_session=True)
        except BlockingIOError:
            return None

    def call(self, action, *, launch=False, request_timeout=45, **args):
        if launch:
            self.launch()
        key = uuid.uuid4().hex
        request = self.box / f"{key}.request"
        response = self.box / f"{key}.response"
        payload = {"action": action, "args": args, "deadline": time.time() + request_timeout}
        epoch = self.box / EPOCH
        if action != "ping" and epoch.is_file():
            payload["epoch"] = json.loads(epoch.read_text())["id"]
        if len(json.dumps(payload).encode()) > MAX_REQUEST:
            raise ValueError("指示または設定が長すぎます")
        write(request, payload)
        try:
            end = time.monotonic() + request_timeout
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
    if (not isinstance(data, dict) or set(data) - {"epoch"} != {"action", "args", "deadline"}
            or ("epoch" in data and (not isinstance(data["epoch"], str)
                                    or not re.fullmatch(r"[a-f0-9]{32}", data["epoch"])))
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
        epoch = getattr(service, "ipc_epoch", None)
        if epoch and data["action"] != "ping" and data.get("epoch") != epoch:
            raise ValueError("監督が再起動しました。状態を確認してから操作をやり直してください")
        value = {"value": await service.dispatch(data["action"], data["args"])}
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        value = {"error": "IPC の JSON が不正です"}
    except TimeoutError:
        value = {"error": "処理がタイムアウトしました。送信結果が不明な場合は操作履歴から GitHub で照合してください"}
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


async def serve(home, binary, *, root=None, config=None):
    box = mailbox(home)
    with owner_lock(home) as lock:
        if (home / DESKTOP_TRANSFER).exists():
            raise ValueError("Desktop の移行を完了してから監督を起動してください")
        store = Store(home)
        service = Service(store, binary, lease=lock.fileno())
        try:
            if root is not None:
                from .local import bind_project
                await bind_project(service, root, config)
            store.recover()
            if root is not None:
                service.ipc_epoch = uuid.uuid4().hex
                write(box / EPOCH, {"id": service.ipc_epoch})
        except BaseException:
            store.db.close()
            raise
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
