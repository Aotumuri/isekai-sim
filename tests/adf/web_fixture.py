"""Local-only Web E2E backend using disposable data and simulated services."""

import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch

from adf.ipc import Client, serve
from adf.local import home_for, setup
from adf.web import WebServer
from test_adf import FAKE
from test_project_local import project_fixture


async def main():
    issue = {"number": 8, "id": 8, "title": "Synthetic evidence", "state": "open",
             "body": "- [ ] Cross-check\n\n<script>unsafe()</script>", "labels": [{"name": "status:ready"}]}

    async def github(repository, method, endpoint, payload=None, **kwargs):
        assert repository == "example/research"
        if method == "PATCH":
            issue.update(payload)
            raise TimeoutError("simulated lost response")
        if endpoint == "issues/8":
            return deepcopy(issue)
        return []

    async def issue_list(*args):
        return [issue]

    with tempfile.TemporaryDirectory(prefix="adf-browser-") as temp:
        root = project_fixture(Path(temp) / "test", full=True)
        config = setup(root)
        home = home_for(root)
        client = Client(home)
        with (patch("adf.tracker.gh_api", github), patch("adf.github_research.gh_api", github),
              patch("adf.service.issues", issue_list)):
            daemon = asyncio.create_task(serve(home, FAKE, root=root, config=config))
            await asyncio.to_thread(client.call, "ping", launch=False)
            await asyncio.to_thread(client.call, "tracker-policy", launch=False,
                                    operations={"progress": "ask", "checklist": "ask"})
            with WebServer(home) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    print(json.dumps({"url": f"{server.origin}/#access={server.token}",
                                      "root": str(root), "python": sys.executable}), flush=True)
                    await daemon
                finally:
                    server.shutdown()
                    thread.join()


if __name__ == "__main__":
    asyncio.run(main())
