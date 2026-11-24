---
name: developer
description: Start or explicitly resume the isekai-sim Developer primary session with the saved research checkpoint.
---

Start the independent Developer role in this thread when the user explicitly invokes this skill.

From the repository root, read `AGENTS.md`, `agents/docs/roles/developer.md`, and `agents/config.toml`. Inspect `python3 agents/tools/research.py status` and recover the relevant Git, tracker, and job context using the role guide.

- A bare invocation does not lift a stop or take another thread's ownership. In a running lifecycle, establish the current thread's own ownership with the existing claim command before doing work. Stop if the claim fails.
- On an explicit resume request, follow the role guide's recovery and resume procedure. Transfer ownership only after confirming that the previous Developer has ended. Continue the recovered work within its authorized scope.
- Handle direct shutdown requests using the role guide. Treat wake notifications as events subject to the existing wake guard.
