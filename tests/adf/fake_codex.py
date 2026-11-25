#!/usr/bin/env python3
"""Deterministic JSON-RPC fixture for ADF orchestration tests."""

import base64
import itertools
import json
import sys
import subprocess
import threading

serial = itertools.count(1)
lock = threading.Lock()
requests = {}
jobs = {}
turns = {}
provider = "chatgpt"
research_cycles = {}


def send(payload):
    with lock:
        print(json.dumps(payload), flush=True)


def answer(key, result):
    send({"id": key, "result": result})


def event(method, **params):
    send({"method": method, "params": params})


def complete(thread, turn, status="completed", error=None):
    event("turn/completed", threadId=thread, turn={"id": turn, "status": status, "error": error})


def begin(key, params):
    thread = params["threadId"]
    turn = f"turn-{next(serial)}"
    turns[thread] = turn
    text = params["input"][0]["text"]
    answer(key, {"turn": {"id": turn}})
    event("turn/started", threadId=thread, turn={"id": turn})
    event("item/agentMessage/delta", threadId=thread, turnId=turn, delta="fixture output")
    event("thread/tokenUsage/updated", threadId=thread, turnId=turn, tokenUsage={"total": {"totalTokens": 17}})
    if "FIXTURE_RESEARCH" in text or (text.startswith("ADF experiment ") and thread in research_cycles):
        cycle = research_cycles.get(thread, 0)
        research_cycles[thread] = cycle + 1
        request = f"research-{turn}"
        if cycle < 2 and "NO_EXPERIMENT" not in text:
            tool, arguments = "adf_research_experiment", {
                "name": f"Calculation {cycle + 1}", "timeout": 5,
                "program": "import os,time; from pathlib import Path; time.sleep(.25); "
                           "value=sum(i*i for i in range(1000)); "
                           "Path(os.environ['ADF_ARTIFACTS'], 'result.txt').write_text(str(value)); print(value)",
            }
        else:
            tool, arguments = "adf_finish_research_task", {"outcome": "completed", "summary": "Verified fixture"}
        requests[request] = (thread, turn)
        send({"id": request, "method": "item/tool/call", "params": {
            "threadId": thread, "turnId": turn, "tool": tool, "callId": request, "arguments": arguments,
        }})
    elif text.startswith("launch experiment"):
        request = f"call-{turn}"
        requests[request] = (thread, turn)
        send({"id": request, "method": "item/tool/call", "params": {
            "threadId": thread, "turnId": turn, "tool": "adf_start_experiment",
            "callId": request, "arguments": {"template": "trial"},
        }})
    elif text == "quota":
        complete(thread, turn, "failed", {"codexErrorInfo": "usageLimitExceeded"})
    elif text != "hold":
        complete(thread, turn)


def execute(key, params):
    job = params["processId"]
    finished = threading.Event()
    jobs[job] = finished

    def finish():
        if params["command"][0] == "/bin/sh":
            result = subprocess.run(params["command"], cwd=params["cwd"], env=params["env"],
                                    check=False, capture_output=True, text=True, timeout=6)
            answer(key, {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
            return
        interrupted = finished.wait(float(params["command"][-1]))
        event("command/exec/outputDelta", processId=job, stream="stdout", capReached=False,
              deltaBase64=base64.b64encode(b"EXPERIMENT_COMPLETED\n").decode())
        answer(key, {"exitCode": 137 if interrupted else 0, "stdout": "", "stderr": ""})

    threading.Thread(target=finish, daemon=True).start()


for line in sys.stdin:
    frame = json.loads(line)
    key = frame.get("id")
    method = frame.get("method")
    args = frame.get("params", {})
    if not method and key in requests:
        thread, turn = requests.pop(key)
        complete(thread, turn)
        complete(thread, turn)  # Replayed completion must not generate a second wake.
    elif method == "initialize":
        answer(key, {})
    elif method == "account/read":
        answer(key, {"account": {"type": provider, "planType": "plus"}})
    elif method == "thread/start":
        assert args["permissions"] in ("adf-reader", "adf-writer")
        answer(key, {"thread": {"id": f"thread-{next(serial)}"}})
    elif method == "thread/resume":
        answer(key, {"thread": {"id": args["threadId"]}})
    elif method == "turn/start":
        assert args["permissions"] in ("adf-reader", "adf-writer") and args["approvalPolicy"] == "never"
        begin(key, args)
    elif method == "turn/steer":
        answer(key, {})
    elif method == "turn/interrupt":
        answer(key, {})
        complete(args["threadId"], args["turnId"], "interrupted")
    elif method == "command/exec":
        assert args["permissionProfile"] in ("adf-writer", "adf-experiment")
        execute(key, args)
    elif method == "command/exec/terminate":
        jobs[args["processId"]].set()
        answer(key, {})
    elif method == "account/rateLimits/read":
        answer(key, {"rateLimits": {"primary": {"usedPercent": 20, "resetsAt": None}}})
