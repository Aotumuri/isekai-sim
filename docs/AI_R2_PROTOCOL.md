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

## Iteration records

See [AI_R2_EXPERIMENT_HISTORY.md](AI_R2_EXPERIMENT_HISTORY.md) for R2.1 onward,
including unsuccessful trials, causal findings, performance checks and the next hypothesis.
The continuation from R2.10 is in [AI_R2_EXPERIMENT_HISTORY_2.md](AI_R2_EXPERIMENT_HISTORY_2.md).
