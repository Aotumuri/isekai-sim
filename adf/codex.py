"""Codex App Server adapter. The controller owns all scheduling decisions."""

import asyncio
import base64
import json
import os
from pathlib import Path
import signal
import sys

PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TOOL = "adf_start_experiment"


def environment():
    keys = ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR",
            "CODEX_HOME", "CODEX_SQLITE_HOME")
    return {**{key: os.environ[key] for key in keys if key in os.environ}, "PATH": PATH}


def profile_options():
    profiles = []
    for name, mode in (("adf-reader", "read"), ("adf-writer", "write")):
        rules = {".": mode, ".git": "read", ".agents": "read", ".codex": "read", ".aws": "read",
                 ".env": "deny", "**/.env": "deny", "**/.env.*": "deny"}
        paths = ", ".join(f"{json.dumps(path)}={json.dumps(access)}" for path, access in rules.items())
        profiles.append(f'{name}={{filesystem={{":root"="deny", ":minimal"="read", '
                        f'":workspace_roots"={{{paths}}}}}, network={{enabled=false}}}}')
    return "-c", "permissions={" + ", ".join(profiles) + "}", "-c", 'default_permissions="adf-reader"'


def profile(role):
    return "adf-writer" if role == "developer" else "adf-reader"


def text_input(text):
    return [{"type": "text", "text": text}]


class RuntimeError(Exception):
    pass


class Codex:
    def __init__(self, binary, event, tool, disconnected, lease=None):
        self.binary = binary
        self.lease = lease
        self.event = event
        self.tool = tool
        self.disconnected = disconnected
        self.process = None
        self.pending = {}
        self.requests = set()
        self.serial = 0
        self.closing = False
        self.reader = None
        self.life = None

    async def open(self):
        life, self.life = os.pipe()
        try:
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-I", str(Path(__file__).with_name("runtime_host.py")),
                str(life), str(-1 if self.lease is None else self.lease),
                self.binary, "app-server", "--listen", "stdio://", "--strict-config",
                "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"',
                "-c", 'service_tier="default"',
                "-c", 'mcp_servers={}', "-c", 'features.apps=false',
                "-c", 'features.multi_agent=false', "-c", 'features.multi_agent_v2=false',
                "-c", 'web_search="disabled"',
                "-c", 'shell_environment_policy.inherit="none"',
                *profile_options(),
                "-c", f'shell_environment_policy.set.PATH="{PATH}"',
                cwd=Path.home(), env=environment(), start_new_session=True,
                pass_fds=(life,) if self.lease is None else (life, self.lease),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=8 * 1024 * 1024)
        finally:
            os.close(life)
        self.reader = asyncio.create_task(self.read())
        await self.rpc("initialize", {"clientInfo": {"name": "adf_standalone", "version": "0.1.0"},
                                      "capabilities": {"experimentalApi": True}})
        await self.send({"method": "initialized"})
        await self.check_account()

    async def check_account(self):
        result = await self.rpc("account/read", {"refreshToken": False})
        account = result.get("account") or {}
        if account.get("type") != "chatgpt":
            raise RuntimeError("Codex の既存 ChatGPT ログインが必要です")
        return account


    async def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False).encode() + b"\n")
        await self.process.stdin.drain()

    async def rpc(self, method, params, timeout=30):
        self.serial += 1
        key = self.serial
        future = self.pending[key] = asyncio.get_running_loop().create_future()
        try:
            await self.send({"id": key, "method": method, "params": params})
            result = await asyncio.wait_for(future, timeout)
        except (TimeoutError, OSError):
            raise RuntimeError(f"Codex RPC {method}: 切断またはタイムアウト") from None
        finally:
            self.pending.pop(key, None)
        if "error" in result:
            # Provider error details can include local paths and request content.
            raise RuntimeError(f"Codex RPC {method}: エラー {result['error'].get('code')}")
        return result.get("result") or {}

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                key = message.get("id")
                if key is not None and "method" in message:
                    task = asyncio.create_task(self.answer(message))
                    self.requests.add(task)
                    task.add_done_callback(self.requests.discard)
                elif key is not None:
                    future = self.pending.get(key)
                    if future and not future.done():
                        future.set_result(message)
                else:
                    self.event(message["method"], message.get("params", {}))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Codex App Server が切断されました"))
            if not self.closing:
                self.disconnected(self)

    async def answer(self, message):
        method = message["method"]
        params = message.get("params", {})
        if method == "item/tool/call":
            success, text = await self.tool(params)
            result = {"success": success, "contentItems": [{"type": "inputText", "text": text}]}
        elif method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
            self.event("adf/approvalDenied", params)
            result = {"decision": "decline"}
        else:
            await self.send({"id": message["id"], "error": {"code": -32601, "message": "ADF denied request"}})
            return
        await self.send({"id": message["id"], "result": result})

    async def thread(self, session, settings, instructions):
        writable = session["role"] == "developer"
        params = {"cwd": session["path"], "approvalPolicy": "never",
                  "permissions": profile(session["role"]), "runtimeWorkspaceRoots": [session["path"]],
                  "developerInstructions": instructions, "modelProvider": "openai",
                  "serviceTier": "default"}
        if settings["model"]:
            params["model"] = settings["model"]
        if session["thread"]:
            params.update(threadId=session["thread"], excludeTurns=True)
            result = await self.rpc("thread/resume", params)
        else:
            if writable:
                params["dynamicTools"] = [{
                    "type": "function", "name": TOOL,
                    "description": "Launch one human-configured experiment against the committed revision. "
                                   "After it starts, end the turn immediately.",
                    "inputSchema": {"type": "object", "properties": {
                        "template": {"type": "string"}}, "required": ["template"],
                        "additionalProperties": False},
                }]
            params["allowProviderModelFallback"] = False
            result = await self.rpc("thread/start", params)
        return result["thread"]["id"]

    async def start(self, session, settings, prompt):
        params = {"threadId": session["thread"], "input": text_input(prompt), "cwd": session["path"],
                  "approvalPolicy": "never", "serviceTier": "default",
                  "permissions": profile(session["role"]), "runtimeWorkspaceRoots": [session["path"]],
                  "multiAgentMode": "explicitRequestOnly"}
        if settings["model"]:
            params["model"] = settings["model"]
        if settings["effort"]:
            params["effort"] = settings["effort"]
        return (await self.rpc("turn/start", params))["turn"]["id"]

    async def steer(self, thread, turn, text):
        await self.rpc("turn/steer", {"threadId": thread, "expectedTurnId": turn, "input": text_input(text)})

    async def interrupt(self, thread, turn):
        await self.rpc("turn/interrupt", {"threadId": thread, "turnId": turn}, timeout=10)

    async def execute(self, job, source, template):
        return await self.rpc("command/exec", {
            "command": template["argv"], "cwd": str(source), "processId": job,
            "permissionProfile": "adf-writer", "timeoutMs": template["timeout"] * 1000,
            "env": {"PATH": PATH, "HOME": str(source), "TMPDIR": str(source)},
            "outputBytesCap": 131072, "streamStdoutStderr": True,
        }, timeout=template["timeout"] + 15)

    async def terminate(self, job):
        await self.rpc("command/exec/terminate", {"processId": job}, timeout=10)

    async def limits(self):
        await self.check_account()
        return await self.rpc("account/rateLimits/read", {})

    async def close(self):
        self.closing = True
        if self.life is not None:
            os.close(self.life)
            self.life = None
        if self.process and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 3)
            except TimeoutError:
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            except ProcessLookupError:
                await self.process.wait()
        if self.reader:
            await asyncio.gather(self.reader, return_exceptions=True)
        for task in self.requests.copy():
            task.cancel()


def output_delta(params):
    return base64.b64decode(params["deltaBase64"], validate=True)
