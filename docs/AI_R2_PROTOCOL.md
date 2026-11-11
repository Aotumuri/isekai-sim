# WarCampaign R2: prospective evaluation protocol

R1 is an intermediate experiment, not completion of the quality objective.
This protocol is recorded before R2 prototype results. Existing R1 data and all
previous holdouts are development evidence, never new final evaluation data.

## Frozen references and conditions

- Legacy: main `394d4bd`; the R1 source with campaign disabled was previously
  verified equivalent on 260 development trajectories. Recheck equivalence if
  shared execution code changes.
- R1: `e6245a1` (simulation source `93ba1cf`), campaign enabled.
- R2: individually committed prototypes, explicit revision in every report.
- Same combat, economy, political, peace-border and movement rules for all arms.
  Full systems, normal wars, 640x360 quick fixtures, 10,000 fast ticks; all 13
  scenarios from the final R1 matrix. Default-map runs and long soaks supplement
  these fixtures rather than replacing them.
- Development seeds: 822748319780–799. Causal diagnostics include previously
  observed failures; new diagnostic seeds: 1022748319780–799.
- Final seeds reserved, not inspected during development: 1122748319780–819
  (40 per scenario). If the final candidate fails, disclose that result and
  reserve another disjoint range before further development.

## Decision and adoption gates

1. Mandatory: deterministic decisions and trajectories; legal orders and peace
   terms; cleanup after peace/extinction; preserve manual orders and emergency
   defense; full regression suite, build and quick benchmark pass.
2. Strategy must compare explicit alternatives with estimated final benefit,
   cost, risk, uncertainty and switching cost. Territorial footholds cannot be
   reported as final territorial gains when peace rules prohibit retaining them.
3. At least two distinct scenario families must improve on Legacy and R1 on a
   prespecified quality axis: final opening-war objective retention, unnecessary
   travel cancellation, or productive amphibious completion per transport loss.
   Report paired 95% seed-bootstrap intervals (10,000 resamples, fixed RNG),
   means, medians, worst cases and all scenario results. A positive mean alone
   without an interval excluding zero is tentative evidence, not a passed gate.
4. Report attackers and defenders separately. Check survival, legal territorial
   gains/losses, casualties, elapsed war time, mobilization/production/resource
   costs, endogenous war frequency and censored unfinished wars. Do not add the
   opposing sides' scores into a purported overall utility. Flag a survival or
   final objective decline above 5 percentage points, or casualty/resource-cost
   increase above 15%, in any family; inspect paired failures before adoption.
   A statistically clear material regression fails adoption unless a documented
   strategic benefit explains it without violating emergency protection.
5. Consistency: allocation counts alone are not evidence of wasted travel.
   Trace geometrical remapping, membership changes, emergencies, policy changes,
   and actual interrupted movement. Never equate every reassignment with error.
6. Performance: isolate same-state decision cost from trajectory-dependent total
   simulation cost. Report strategy time, subsystem CPU, world/unit counts and
   long-soak memory. A >20% median end-to-end CPU increase needs a measured
   quality benefit and optimization attempt; unbounded growth fails adoption.
7. A failed prototype starts the next iteration. Passing tests or completing a
   matrix is not completion. Keep the feature opt-in until the final gates pass.

## R2.1: causal diagnosis

Hypothesis: rebuilding allocations from an empty assignment can cause reciprocal
swaps while units are still traveling, amplified by changes in posture, desired
strength, operation membership and reserves. This is a hypothesis, not a result.
Observe subsystem boundaries without mutating game state, and verify trajectory
equivalence with the existing recorded benchmark before drawing conclusions.

Read-only traces reproduce every non-CPU end-world field and every existing
counter in four recorded runs: stalemate seed 822748319784 and reorganization
seed 822748319788, Legacy/R1. Their 43/211 and 103/392 transfer counts match the
authoritative allocator exactly after reproducing geometrical remapping.

The reciprocal-swap hypothesis is not supported in these cases (zero same-tick
reciprocal pairs). In R1 stalemate, 125/211 transfers leave a vanished front;
reorganization has 77/392 such transfers and one 233-unit transfer between live
fronts during a major defense change. These counts cannot all be called waste.

Movement has an independent structural problem: target-assignment functions
reset edge progress before determining whether the new destination uses the
same first edge. Same-edge destination changes with progress reset occur
1,259/1,544 times in Legacy/R1 stalemate and 929/2,513 in reorganization.
Other same-order resets may be enemy-blocked arrivals, so total resets and their
progress sum are descriptive and must not be presented as unnecessary travel.
Actual changed-edge events still need threat/topology context for interpretation.
This evidence supports testing continuity of a still-valid first edge, rather
than delaying strategy review or prohibiting useful front transfers.

### R2.1 prototype result: not adopted

Commit `166ba18`, 20 development seeds × four families, full normal systems,
10,000 ticks. Same-edge retarget resets virtually disappear in the traced cases,
but this local correction does not establish national quality. Active-war
opening attacker survival is Legacy 77%, R1 82%, prototype 69%; reorganization
transfers are 65.55/84.30/98.05. Stalemate attacker objective retention is
65%/60%/65%, while defender survival is 55%/75%/55%. Two-island attacker survival
returns from R1's 95% to 100%, but territorial success remains zero. Outcomes are
mixed and some material point-estimate regressions remain. Full data are retained
in `diagnostics/war-ai-r2-1-development.json.gz`; no final seeds were inspected.

Remove the movement-continuity integration from R2.2 to isolate the national
decision model. The prototype remains recoverable from its commit. Do not claim
that fewer discarded same-edge movements proved a better overall AI.

## R2.2: explicit national alternatives (pending)

Compare limited offense, defense/recovery and settlement using reachable force,
arrival time, political rather than temporary territorial benefit, observed
casualty flow, replacement resources, homeland exposure, uncertainty and committed
travel. Preserve critical-capital and exhausted-budget overrides. Carry R1's
execution rules unchanged so this trial isolates national decision quality.

The first model uses a 30-second horizon. Relative squared force and estimated
arrival provide a bounded success estimate, not a new combat rule. It discounts
uncertainty explicitly, projects an exponentially smoothed observed casualty
flow, prices replacement shortages, and charges switching according to force
already traveling or committed. Territory value is normalized to current
homeland value; force costs to opening field strength. Weapon concessions use
the existing infantry manpower/weapon ratio as a rough resource equivalent.
These approximations require empirical checking; no predictive accuracy is
claimed before measurement. Critical-capital and exhausted-budget safeguards
precede the option ranking. Periodic review remains eight virtual seconds, with
earlier review when estimated improvement exceeds uncertainty and switching cost.

A singleton goal that cannot legally be ceded (including an isolated port or
capital) receives a fixed coercive purpose at adoption, with a bounded weapon
concession target. Military control remains separately visible. Terminal success
requires legal ownership or an actual qualifying negotiated concession from
this war; temporary occupation and opening offers are insufficient. Recognition
offers use the same legality, affordability and maturity rules as existing AI.

Validation before the development matrix: 677 regression tests passed and the
production build passed. The optional whole-source `tsc` command also exposes
existing renderer/unused-symbol errors outside this change; the repository's
required test typecheck passes. The standard quick benchmark and long/final
evaluations remain pending; passing unit tests does not adopt the prototype.
