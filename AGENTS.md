# Agent guidance

`isekai-sim` is an autonomous fictional-world and geopolitical history simulator. The current product phase is the **Observation Kit**: people observe and investigate a world that evolves without them. Do not add direct player control of armies, diplomacy, government policy, commanders, or national decisions as the default direction. Existing controls may remain for compatibility.

Before architectural or gameplay changes, read [the project vision](docs/PROJECT_VISION.md) and [the simulation-time policy](docs/SIMULATION_TIME.md). They distinguish agreed targets from current implementation.

Key policies: 1 fastTick is intended to represent one in-world day; 1 slowTick, ten days; years have 365 days. Engine milliseconds are scheduling units, not calendar time. Research is intended to progress beyond level 10, with controlled costs and effects. Design and validate for hundreds of nations and long runs, measuring behavior and computational cost with deterministic representative benchmarks.

Follow existing repository conventions and preserve behavior unless a task requires change. On `main` when instructed, make focused local commits. Never push or open a PR unless explicitly authorized.
