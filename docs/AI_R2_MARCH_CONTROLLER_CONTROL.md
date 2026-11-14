# R2.19: ordinary march continuity under the R1 controller

Preregistered before implementation/results. R2.18's matrices are complete and
rejected; its queued whole-episode cost observations continue unchanged.
The additional peace/subject observations also continue independently.

Question: does the large travel improvement itself create the national safety
regression, or does its interaction with the later R2 controller matter?
R2.14 combined modern scoring/budgets with march continuity. R2.16/17's
selection controls intentionally retained those other R2 mechanisms, so they
did not answer this question. Do not blindly roll back safeguards or claim an
old controller is better because the opponent becomes weaker.

Create one isolated source control from R1 `e6245a1` (production source
`93ba1cf`), applying only the already tested R2.14 ordinary march-continuity
patch: unchanged front and campaign revision, same newly validated first
edge, no special mission/manual/capital emergency, no restoration of blocked
arrival time. No new coefficient, war rule, objective or diplomatic behavior.
This is a causal source control, not permission to revert all later R2 fixes
or activate a new default. Archive the complete patch and source hash.

First compare stalemate/reorganization, all 20 development seeds 822748319780–
799, 10,000 ticks, 640x360 quick, full systems/political turbulence, normal
wars. Use archived matching R1/Legacy matrix subsets; verify source equivalence
and identical settings/starts. Record the new 40-case matrix, whole-episode
cost/government replay, and movement-phase travel audit. Replay R1 travel on
the same 40 cases with a prospective supplemental physical context below.
If the control is promising, extend independent checks to Legacy travel and
the remaining development families before any unused final seeds. Negative
results still inform the next correction. Adoption gates remain unchanged.

Keep the original seven travel observations unchanged. Add a supplemental
same-front ordinary physical context that excludes special ownership and
enemy blocking but **does not filter on campaign revision**. Report discarded
same-edge retarget time, events, retarget exposure and travel exposure. This
avoids silently comparing different controller revision semantics; it does
not claim every policy change is unnecessary. Keep all-unblocked and original
mission-conditioned views as separate evidence, and verify observation parity.
Use new output paths and observer hashes; do not rewrite old experiment data.

Before matrices: typecheck, full inherited regressions plus march-specific
tests, build and quick benchmark. Require off-mode/manual/emergency/mission
protection, deterministic legal behavior and bounded previous-pass storage.
Compare own attacker/defender goals, survival, legal gains, cost distributions
and censoring separately, with existing paired 95%/10,000 bootstrap intervals.
No sum of opposing interests or speed claim from concurrent/historical runs.
If outcomes worsen, do not reduce the safety requirement to adopt travel gains.

Before inspecting R2.19 national outcomes, also specify the existing-data
interaction contrast: pair archived R2.13 (no continuity) and R2.14 (continuity)
with R1 and R2.19 on these same 40 cases. For each role's common outcome,
bootstrap by seed the difference
`(R2.14 - R2.13) - (R2.19 - R1)`. This describes interaction with the **whole
controller bundle**, not an isolated scoring coefficient or budget. Require
identical starts/settings and keep original data unchanged. It can distinguish
a general movement effect from controller-dependent effects, but cannot by
itself justify adopting an older architecture or weakening a safety gate.

## Completed initial comparison

All 40 matrix cases and three 40-case observation sets completed. R1 travel,
candidate travel and candidate cost/government replays reproduce their matching
reference non-CPU end summaries and full war outcomes. No original/final seeds
or R2.16 conditions changed. Results remain a source control, not an adoption.

| Family | R1 attacker goal → continuity | R1 defender survival → continuity |
| --- | ---: | ---: |
| Stalemate | 60% → 65% | 75% → 60% |
| Reorganization | 60% → 50% | 70% → 80% |

Paired 95% intervals: stalemate defender survival -15 pp [-30, 0];
reorganization attacker goal -10 pp [-25, 0] and defender survival +10 pp
[0, +25]. These intervals include zero; the material survival decline remains
a safety concern, not proof of a statistically established universal effect.
All-war averages must not replace these fixed opening-war outcomes.

Supplemental same-front discarded unit time falls by 321.335 seconds
[-547.815, -144.855] in stalemate and 255.965 [-390.605, -141.180] in
reorganization. This is unit travel time, not faster computation or shorter
wars. The travel gain alone does not justify adopting the control.

The preregistered controller-bundle interaction in defender survival is
+5 pp [0, +15] for stalemate and -5 pp [-20, +10] for reorganization.
It does not establish the newer scoring model as the sole cause of the
regression. All four cells have identical starts, settings and external goals.
Raw interaction data and its replayable calculation are archived separately.

Selected new stalemate defender defeats are seeds 780/790/792 (full development
prefix 822748319), where R1 ends the opening war at tick 410 and continuity
instead ends it in defeat at 406/376/356. Trace the actual orders, capital
defense and peace timing before changing behavior; do not use these selected
contrasts as a population estimate. The first paired lifecycle trace uses 780.

The whole-episode cost report also flags a tradeoff: stalemate attacker
unavailable manpower rises by 51,183 [5,987, 110,123] against R1. This scope
includes later wars; it is not the opening war's casualty count and does not
prove every extra loss is unproductive. It reinforces the need for national
outcomes and costs alongside reduced discarded travel time.

Seed-780 lifecycle replays and fast-window replays preserve reference end
summaries and full outcomes. Common slow samples are identical between the
slow and fast observation variants. The first capital divergence occurs at
284, when continuity's defender evacuates from meso-0 to meso-89; R1 retains
meso-0. At 270 continuity already has three attacker units targeting or moving
toward meso-0, whereas R1 has none. Continuity's unit-87 reaches meso-0 at 284.
The defending unit-48 is present on that capital at 270/280, then absent by
283. Therefore simple lack of a guard is not established. Readiness/organization
around that disappearance is the next bounded observation; no game behavior
or rule has been changed on the basis of this selected case.

The readiness trace adds only `UnitState.org`. In continuity, unit-48 has
1196.8 manpower/org 0.428 at 270, 1193.6/org 0.035 at 280, and disappears
at 281. Enemy unit-87 arrives at 284. R1's guard remains around 1199.9/org
0.841 over 270–290. All eight selected trace variants preserve reference
end summaries and full war outcomes. The observer rejects missing/reversed
fast-window arguments and typechecks. Next inspect existing removal,
capital-defense selection and recovery conditions; these data alone do not
establish a defect in capital defense or the direct battle cause.

The bounded battle window (240–290) also preserves both matching reference
outcomes. Continuity starts a nation-0 versus nation-4 battle on meso-0 at
264; R1 has no battle there during this window. Cumulative defender
organization loss reaches 0.802 by 281. Its timing is consistent with the
guard's organization collapse, but cumulative battle totals do not identify
the individual damage recipient.

At 281, the assessment still listing unit-48 explicitly has
`evaluatedAtTick: 280`. This is a previous slow-pass assessment, not evidence
that evaluation after removal counted a nonexistent unit. The assessment's
friendly strength is also exactly unchanged at 260/270/280 despite the guard's
organization decline. Before interpreting that as a strength-model defect,
record the guard's actual combat power/equipment and the other local units,
plus movement progress for potential reinforcements. This remains read-only
causal observation; no combat, defense cadence or diplomatic rule changes.
