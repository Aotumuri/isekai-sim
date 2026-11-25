"""Keep the daemon lease alive through Codex shutdown without passing it to Codex."""

import os
import signal
import subprocess
import sys
import threading


def main():
    life = int(sys.argv[1])
    lease = int(sys.argv[2])
    os.set_inheritable(life, False)
    if lease >= 0:
        os.set_inheritable(lease, False)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    child = subprocess.Popen(sys.argv[3:], close_fds=True)

    def watch():
        # EOF also covers a crash of the daemon without signal handlers.
        os.read(life, 1)
        stop.set()

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    while child.poll() is None:
        if stop.wait(0.1):
            # Keep this process and its lease alive until the whole group is stopped.
            os.killpg(os.getpgrp(), signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            os.killpg(os.getpgrp(), signal.SIGKILL)
    return child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
