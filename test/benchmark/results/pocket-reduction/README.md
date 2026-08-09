# Pocket Closure baseline and Pocket Reduction comparison

Measured with two fixed seeds (`822748319788`, `822748319780`), 1,200 fast ticks,
1,920×1,080 worlds, strategic reserves/reorganization/exploitation enabled. The
`--pocket-reduction off` runs preserve the pre-reduction target-selection behavior;
the raw JSON files in this directory contain every permanent metric and timing sample.

The dedicated deterministic regression fixtures cover:

- A: 2-region pocket with one trapped unit and local attackers.
- B: 12-region pocket with 10 trapped units and a city; it commits more force and
  starts at the boundary.
- C: topology reconnection; the pocket becomes `reopened` and its Operation is cancelled.

## Pocket Closure baseline (reduction off, averages across both seeds)

| Scenario | opportunities | high value | closure Ops | successes | failed expected closures | pockets | avg lifetime | >100t | >200t | >500t | idle ticks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| active-war | 197.5 | 25.0 | 11.5 | 4.5 | 2.0 | 52.5 | 95.0 | 19.5 | 7.5 | 1.0 | 4,765 |
| stalemate-breaker | 21.0 | 4.0 | 4.5 | 1.5 | 0 | 2.5 | 140.0 | 2.0 | 1.5 | 0 | 445 |
| collapse-advance | 36.0 | 2.0 | 7.0 | 3.0 | 0.5 | 5.5 | 211.3 | 5.0 | 2.0 | 0 | 1,020 |

Baseline trapped strength surviving at 100/200/500 ticks:

| Scenario | 100 ticks | 200 ticks | 500 ticks | reopened |
|---|---:|---:|---:|---:|
| active-war | 11,273 | 3,461 | 788 | 4.0 |
| stalemate-breaker | 2,838 | 882 | 0 | 0 |
| collapse-advance | 1,212 | 979 | 0 | 0.5 |

The baseline establishes the missing behavior: no reduction Operations were created,
and meaningful isolated strength regularly survived for 100–500 ticks.

## Before / after

| Scenario | mode | reductions | destroyed | avg lifetime | >100t | >200t | >500t | strength @100t | idle ticks | all Ops |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| active-war | off | 0 | 43.0 | 95.0 | 19.5 | 7.5 | 1.0 | 11,273 | 4,765 | 22.5 |
| active-war | on | 8.0 | 44.5 | 88.8 | 14.0 | 4.0 | 0.5 | 3,291 | 346.5 | 23.0 |
| stalemate-breaker | off | 0 | 2.5 | 140.0 | 2.0 | 1.5 | 0 | 2,838 | 445 | 10.0 |
| stalemate-breaker | on | 1.0 | 3.0 | 68.0 | 0.5 | 0 | 0 | 312 | 12.5 | 10.0 |
| collapse-advance | off | 0 | 3.5 | 211.3 | 5.0 | 2.0 | 0 | 1,212 | 1,020 | 8.0 |
| collapse-advance | on | 3.0 | 4.5 | 180.8 | 3.0 | 2.0 | 0 | 1,672 | 59.5 | 7.0 |

The two-seed aggregate improves the primary measures: fewer long-lived pockets,
lower average lifetime, less idle time, and more destroyed pockets. The
collapse-advance sample is mixed: 100-tick surviving strength increased even though
pocket count, lifetime, idle time, reopenings, and destruction improved. This is kept
visible rather than treated as a universal win.

Normal operation volume remained essentially stable (active-war 22.5→23.0,
stalemate-breaker 10.0→10.0, collapse-advance 8.0→7.0). Direct Pocket Reduction
evaluation cost was 0.04–0.32% of total simulation wall time, below the 3% target.
Topology analysis remains shared; reduction does not perform a whole-world BFS.

## Scope

No supply, surrender, combat, organization, reinforcement, terrain, or encirclement
bonus was added. Reduction uses the existing Operation preflight, preparation lease,
pathfinding, battle, and occupation lifecycle.
