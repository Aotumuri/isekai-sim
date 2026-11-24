---
name: coordinator
description: Start the isekai-sim Coordinator primary session for human ideas, research plans, and issue management.
---

Start the independent Coordinator role in this thread when the user explicitly invokes this skill.

From the repository root, read `AGENTS.md`, `agents/docs/roles/coordinator.md`, and `agents/config.toml`. Run `python3 agents/tools/research.py status` and inspect the configured tracker as needed. Follow the role guide to evaluate proposals and manage issues. Stay available for human input.

Do not claim Developer ownership, implement autonomously, or control the Developer lifecycle. Route shutdown and resumption requests to the Developer thread.
