# Simulation time and long-term progression

This document records authoritative design targets and migration guidance. It does not describe all current behavior as already compliant.

## Canonical calendar target

- 1 `fastTick` = 1 in-world day.
- 1 `slowTick` = 10 in-world days.
- 1 in-world year = 365 days; no leap years initially.
- 10,000 fast ticks = 10,000 days, about 27.4 years.
- 100,000 fast ticks = 100,000 days, about 274 years.

## Three different clocks

Simulation calendar time, update cadence, and real-world playback speed are separate concepts. `FAST_TICK_MS = 100` and `SLOW_TICK_MS = 1000` in `src/sim/time.ts` are engine scheduling intervals. They are not in-world milliseconds or definitions of how much calendar time passes. Playback speed multipliers govern how quickly scheduled ticks are processed in real time; they must not redefine the calendar.

Currently `updateSimulation` accumulates real elapsed milliseconds, calls fast steps with `FAST_TICK_MS`, and gates slow steps at `SLOW_TICK_MS`. `SimTime.elapsedMs` therefore reflects this engine clock. The mapping of those steps to days above is a future design target, not the current implementation.

## Duration representation and subsystem intentions

When implementing the calendar, add centralized conversions between days, years, fast ticks, and slow ticks. Express conceptual durations in in-world days or years where appropriate. Avoid unexplained numeric literals that encode seconds or ticks. Keep engine scheduling values explicitly named and separate. Do not simply relabel existing second-based mechanics as days.

Provisional balance targets, subject to simulation testing:

| System | Intended timescale |
| --- | --- |
| Democratic elections | About four years |
| Monarchical succession or comparable leadership turnover | Decades, with substantial variation |
| Diplomatic treaties | Commonly multiple years |
| Postwar truces | Commonly five to ten years |
| Industrial recovery | About one to two years, depending on damage and investment |
| Recruitment, mobilization, conflict, research, and economic cycles | Internally coherent relative to one another |

These are balancing intentions, not exact universal durations.

## Current implementation examples and gaps

- `src/sim/politics.ts` schedules elections every 420 slow ticks and succession every 900 slow ticks, with reviews every 30. These are tick counts, not currently documented in-world years.
- `src/sim/diplomacy.ts` stores treaty expiry in slow ticks (for example, 400 or 600), while truce extension configuration and event text call values seconds. This mixes tick-based storage with second-based assumptions.
- `src/sim/war-campaign/forecast.ts` converts movement distance and milliseconds to seconds; campaign horizons and loss rates also use seconds (`alternatives.ts`).
- `src/sim/food-supply.ts` reports reserve duration in seconds. `src/data/balance.ts` includes a duration comment tied to the current 100 ms fast tick.
- `src/sim/research.ts` advances research on slow ticks, so its cadence and project costs need coherent calendar interpretation.
- `src/sim/simulation-settings.ts` records events by fast tick and retains only the latest 200 events. This rolling window is not a long-term historical record.

These examples illustrate migration scope; they are not an exhaustive audit. Also audit military travel, campaign forecasts, losses per second, war fatigue, elections, treaties, production, food, population, recovery, and research. Inspect `src/sim/update.ts` to understand which systems run at fast versus slow cadence.

## Migration and validation

Before adopting the mapping, audit every fast/slow tick dependency and persisted state. Define deterministic conversion and rounding rules, and decide how existing or serialized worlds remain compatible. Preserve deterministic behavior where possible and document any intentional migration. Validate that changing playback speed changes wall-clock throughput only, not the same world's calendar or outcomes for a given tick sequence.

Use representative multi-nation worlds and multiple deterministic seeds. Check behavioral correctness alongside CPU and memory cost. Long-run targets begin at 10,000 fast ticks, then 50,000–100,000 where practical; inspect active diplomacy, economics, politics, and technology, runaway values, permanent stagnation, invalid territory, numerical errors, and scaling. Compare important changes against a performance baseline. Event-driven work, shared calculations, and lower-frequency updates are preferred where they preserve meaningful behavior.

These are validation targets for implementation work. They do not require expensive long simulations for documentation-only changes.

## Research progression policy

Research levels must not have a fixed maximum of 10. Later work should remove level-10 restrictions in research selection and equipment design derivation, increase costs at higher levels, and use diminishing marginal benefits where appropriate. Avoid combat, movement, production, or economic inflation. Physical performance can saturate sensibly while technology continues to provide benefits in other dimensions. National differences should remain meaningful through investment, resources, policy, and knowledge transfer. Keep progression deterministic and computationally efficient.

Current `src/sim/research.ts` still stops selecting branches at level 10, clamps design inputs to 0–10, and marks a program complete when all applicable branches reach 10. This is an explicit implementation gap against the agreed target. No research behavior or balancing constants are changed by this policy document.
