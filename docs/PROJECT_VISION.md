# Project vision

## Purpose

`isekai-sim` is an autonomous fictional-world and geopolitical history simulator. Its central experience is observing a world map and its societies change over long periods: nations wage war, negotiate, expand, collapse, integrate peacefully, gain independence, secede, and form new political orders. The simulation should be meaningful without a human controlling any nation.

**North star:** Build a living fictional world where hundreds of autonomous nations interact and generate their own history, and where humans can observe how the world map, political order, and societies change over long periods of time.

The intended center is the world map and nation-centered history, rather than a conventional player-controlled strategy game. Important people can add personality and causal depth, but are not the primary unit of simulation.

## Product stages

### Stage 1: Observation Kit — current priority

The human is an observer. The intended public experience includes world generation and initial settings; pause, resume, and speed controls; map navigation and selection of nations, regions, and individuals; visual overlays; inspection of national information, decisions, statistics, events, and historical maps; and investigation of why developments occurred.

Do not develop new direct player-control features in this stage. In particular, direct control of armies, diplomacy, government policy, commanders, or national decisions is not the default direction. Existing player-control code may remain for compatibility and should not be removed solely because of this policy. Developer diagnostics and automated test controls are separate from public observation features.

### Stage 2: Intervention Kit — future

Allow external influence and controlled experiments on the simulated world. This is out of scope for current feature development.

### Stage 3: Possession / Embodiment — future

Allow a human to take the perspective or decision-making role of a nation or individual inside an already-running autonomous world. This is also out of scope now.

Keep architecture from needlessly obstructing these stages, but do not prematurely build their interfaces or systems.

## Simulation principles

- **Autonomy:** The world evolves independently of human input.
- **Emergence:** History arises from interacting systems and incentives, not arbitrary quotas for scripted events.
- **Causality:** Major events have understandable causes grounded in world state and prior history.
- **Continuity:** Decisions and events affect later developments.
- **Observability:** Important decisions, motivations, and consequences can be inspected.
- **Scalability:** Prefer efficient systemic behavior over computationally expensive detail for every individual.
- **Long-term stability:** Design for hundreds of nations and tens of thousands of ticks or more.
- **Performance awareness:** Assess both behavior and computational cost when adding features.

Political maps should change through plausible military and non-military processes, including peaceful integration, federalization, independence, secession, collapse, and negotiated territorial changes. Changes need meaningful conditions and consequences; do not force activity on a fixed schedule. A stable order is also a valid emergent outcome.

## Important individuals

Simulate a limited number of consequential people, not every resident. Start with theater commanders rather than a general-purpose character engine. Commanders should persist in peacetime and retain identity and history across conflicts. Traits, skills, experience, assignments, political relationships, and decision tendencies should affect actual choices. Commanders should have physical headquarters and identifiable areas of responsibility, and their decisions, positions, assignments, and records should be observable. They remain AI-managed during the Observation Kit phase.

Allow future extension to political leaders and other figures without implementing those systems now. Prefer event-driven or low-frequency decisions and reuse strategic assessments instead of recomputing the whole world independently for every character on every tick.

## Historical observation

The chosen model is a historical timeline with inspectable historical world maps. Observers should eventually inspect past borders, political entities, and relevant historical states. Prefer compact periodic snapshots combined with important changes and events over a full copy of every simulation object on every tick. Preserve nation identity, founding, extinction, succession, division, and unification where feasible. Historical inspection must not mutate or rewind the running world. Efficient reconstruction, bounded storage, and histories beyond the short rolling event window matter. Full replay of every military movement is not a current objective.

## Priorities and deferred work

Keep the nation-centered autonomous simulation observable, causally legible, deterministic where applicable, and viable at large scale. The canonical in-world calendar is specified in [SIMULATION_TIME.md](SIMULATION_TIME.md); it is a design target, not a claim about current mechanics. Research must eventually continue beyond level 10, with increasing costs and controlled marginal effects rather than unbounded numerical inflation or meaningless hidden caps.

Intervention and possession experiences, direct player-control expansion, a general-purpose character engine, and detailed full military replay are deferred. Existing documents such as [SOCIETY.md](../SOCIETY.md) and [NAVY.md](../NAVY.md) describe existing systems and remain useful references; this vision governs future planning where priorities differ.
