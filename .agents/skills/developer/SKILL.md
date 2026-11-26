---
name: developer
description: Use the project-local ADF developer workflow from a Codex thread.
---

Read `AGENTS.md` and `adf/roles/developer.md`. Run `python3 -m adf skill developer` from the repository root to inspect the project-local Core without starting research.

- If the user chooses this thread, help with discussion, repository inspection, or review. This thread is an external client and cannot acquire a managed session or automatically wake when an experiment ends.
- If the user chooses managed execution, use the operator commands in `adf/README.md`. Start the appropriate role only on explicit user instruction and only if the official execution environment permits access to the project-local operator interface. For a bounded Developer research run, use `research-start` with the human-approved Mission, scope, issues, and budget. A bare skill invocation stays read-only.
- In a Core-managed session, use the attached ADF tools. Do not use shell IPC, open SQLite, operate the legacy runner, attach an external Codex thread, or take another role's ownership.
