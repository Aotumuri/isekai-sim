"""Loopback-only operator UI. The supervisor owns all research actions."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import threading
import webbrowser

from .ipc import MAX_REQUEST, Client
from .local import running

ASSETS = Path(__file__).with_name("ui")
FILES = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"),
         "/app.js": ("app.js", "text/javascript"), "/markdown.js": ("markdown.js", "text/javascript")}
ACTIONS = frozenset({
    "status", "history", "conversation", "send", "stop", "resume", "shutdown", "config", "config-text",
    "config-save", "issues", "tracker-issue", "tracker-draft", "tracker-review", "tracker-reconcile",
    "tracker-policy", "research-start", "research-resume", "research-preset", "log", "artifacts",
    "experiment-inputs", "limits", "usage", "role", "backup",
})


class WebServer(ThreadingHTTPServer):
    def __init__(self, home):
        self.home = home
        self.client = Client(home)
        self.token = secrets.token_urlsafe(32)
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(("127.0.0.1", 0), WebRequest)
        self.host = f"127.0.0.1:{self.server_port}"
        self.origin = f"http://{self.host}"

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class WebRequest(BaseHTTPRequestHandler):
    timeout = 10

    def log_message(self, *args):
        # The capability is delivered in a browser fragment. Do not log traffic.
        pass

    def host_ok(self):
        return (self.headers.get_all("Host") == [self.server.host]
                and self.headers.get("Sec-Fetch-Site") in (None, "same-origin", "none"))

    def reply(self, status, content, media):
        self.send_response(status)
        self.send_header("Content-Type", media + "; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
                         "base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(content)

    def result(self, status, **data):
        self.reply(status, json.dumps(data, ensure_ascii=False).encode(), "application/json")

    def do_GET(self):
        if not self.host_ok():
            return self.result(403, error="このプロジェクトの接続先を開いてください")
        if self.path not in FILES:
            return self.result(404, error="ページがありません")
        file, mime = FILES[self.path]
        self.reply(200, (ASSETS / file).read_bytes(), mime)

    def do_POST(self):
        auth = self.headers.get_all("Authorization")
        if (not self.host_ok() or self.headers.get_all("Origin") != [self.server.origin]
                or not auth or len(auth) != 1 or not secrets.compare_digest(
                    auth[0].encode(), ("Bearer " + self.server.token).encode())):
            return self.result(403, error="接続が失効しました。GUI を起動した端末の URL を開いてください")
        if self.path != "/api":
            return self.result(404, error="未対応の接続先です")
        try:
            if self.headers.get_all("Content-Type") != ["application/json"] or (
                    len(self.headers.get_all("Content-Length") or []) != 1
                    or self.headers.get("Transfer-Encoding") is not None):
                raise ValueError("JSON の操作を指定してください")
            length = int(self.headers["Content-Length"])
            if not 0 < length <= MAX_REQUEST:
                raise ValueError("操作のサイズが不正です")
            data = json.loads(self.rfile.read(length))
            if (not isinstance(data, dict) or set(data) != {"action", "args"}
                    or not isinstance(data["action"], str) or data["action"] not in ACTIONS
                    or not isinstance(data["args"], dict)
                    or set(data["args"]) & {"request_timeout", "launch", "project"}):
                raise ValueError("未対応の操作です")
        except (KeyError, ValueError, RecursionError) as error:
            return self.result(400, error=str(error))
        action, args = data["action"], data["args"]
        try:
            if not running(self.server.home):
                if action == "status":
                    return self.result(200, value={"running": False})
                return self.result(503, error="監督は停止中です。端末で python3 -m adf start を実行してください")
            value = self.server.client.call(action, launch=False, **args)
        except (OSError, ValueError, TypeError) as error:
            return self.result(409, error=str(error))
        self.result(200, value=value)


def serve_web(home, *, open_browser):
    with WebServer(home) as server:
        url = f"{server.origin}/#access={server.token}"
        print(url, flush=True)
        if open_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
