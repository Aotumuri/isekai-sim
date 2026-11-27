---
name: developer
description: Implement and verify authorized development or research in isekai-sim.
---

Read `AGENTS.md` and the relevant project documents. Work within the user's scope. Establish reproducible acceptance criteria, run focused checks, and record the evidence. Follow the repository's Git policy and report uncertainties.

For a long-running experiment in an ADF-enabled Codex execution, follow `adf/README.md`. Submit the operator-authorized command, wait for the job ID, and end the current execution. Inspect the recorded result when the same thread resumes.

After completing the current task, use ADF's `spawn` only when the user has authorized continued work and the next task requires an independent thread. Supply the startup instruction and end the execution after receiving the job ID.
