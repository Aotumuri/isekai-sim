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

### R2.2 development result: not adopted

Source `2d0bf60`, all 13 scenarios × 20 development seeds, 10,000 ticks, 260
completed rows, no execution failures. Relative to R1, opening attacker objective
retention changes by −8 pp in active-war, −10 pp in stalemate and reorganization,
+5 pp in matched-war and collapse, and +10 pp in economic-constraint. Defender
retention changes by +15 pp in stalemate, +10 pp in reorganization, −5 pp in
matched/collapse and −15 pp in economic-constraint. These opposing interests must
not be added into an overall improvement. Against Legacy, unequal-war attacker
retention falls 20 pp. No final seeds have been used; quality gates remain unmet.
Full distributions and paired seed-bootstrap intervals are archived in the two
`war-ai-r2-2-v-*.json.gz` reports. Confidence intervals are per metric/family,
not a correction for searching many metrics; final confirmation is still needed.

Same-state timing verifies identical non-CPU worlds before replaying decisions.
With active wars, R1 median update cost is 0.013–0.017 ms and R2.2 is
0.214–0.356 ms. Without wars both remain approximately 0.004–0.008 ms.
The national model itself therefore costs more, independently of the changed
trajectory. Initial full matrix rows spend 13–78 ms per 1,000-second episode
inside the campaign stage. End-to-end CPU is separately reported; concurrent
diagnostics and a short normal UI check make these timings descriptive rather
than an isolated speed benchmark.

A new 30-second option probe uses four diagnostic seeds (1022748319780–783),
four families, and the same opening with one nation's choice forced after each
campaign evaluation, while emergency/budget overrides and other nations remain
normal. Limited offense and defense produce identical recorded battle losses,
strength and postures in these 16 pairs. This exposes an execution-contract
problem: `defensiveOpportunity` permits broad attacks in defense, and commitment
preservation can keep existing offensive plans active. Ranking nominal options
does not prove the options cause different actions. Seek-peace is different but
can sacrifice the military route before a settlement is actually acceptable.

Further cost-model audit found that `getWarCasualties` records direct manpower
damage. A unit removed when organization reaches zero can still have substantial
manpower; that removal is not in the direct-damage total. This is not yet a
measured total-loss estimate. Do not interpret the current casualty fraction as
all unrecoverable national force. Combat rules will remain unchanged; diagnose
and account for the missing exposure separately before tuning cost coefficients.

## R2.3: executable choices and complete cost observation (pending)

Next hypothesis: distinguish homeland recovery from foreign expansion in the
execution contract; compare the continuation of a committed operation explicitly;
observe unavailable field force in addition to direct battle damage; and reserve
other theaters' defense before estimating an offensive option's available force.
Use the option probe to verify action differences before another full matrix.

Normal-play UI check at R2.2: generated a new Japan-scale map through the normal
startup screen, observed time advancing, paused, selected a nation, and opened
debug display controls. Screenshot: `diagnostics/war-ai-r2-normal-play.png`.
This checks the normal rendering/control path with the default AI. The experiment
still has no normal-UI opt-in control, so this is not evidence of R2 strategy in
normal play; that remains pending.

R2.3 first isolates execution semantics: ordinary defense permits supported
recovery of occupied homeland, but no longer authorizes foreign expansion merely
because a local ratio is favorable. Emergency and supply/bridgehead relief stay
above that restriction. A foreign offensive commitment cannot silently defeat a
new defense decision. Dedicated tests check both the prohibition and legitimate
homeland counterattack. Cost-ledger changes are deferred to a separate iteration
so this experiment can identify the effect of the execution contract alone.

### R2.3 result: action distinction verified, quality still not adopted

Source `3f82faf`, five families × 20 development seeds, 100 completed episodes.
The diagnostic option probe now distinguishes offense/defense in four of 16
pairs; the other 12 appropriately include situations where the tactical layer
cannot safely attack, sea access is absent, or emergency protection dominates.
This verifies an execution distinction, not better strategy. Relative to R1,
active-war attacker survival increases 3 pp (95% paired interval −4 to +10 pp),
while stalemate attacker target retention falls 15 pp (−30 to 0 pp). Relative to
Legacy, that stalemate decline is 20 pp (−40 to −5 pp), a material failure.
Stalemate transfers increase to 136.7 versus Legacy 75.4 and R1 88.4. R2.3
therefore fails standalone adoption. Its clearer execution contract is retained
only in the next opt-in prototype to test whether a coherent cost signal changes
the decisions it executes; it is not enabled by default.

Independent read-only cost audit: 16 diagnostic episodes per arm, 1,000 ticks,
all start fingerprints equal across Legacy/R1/R2.3. Snapshot units and cargo
after repositioning and after battle, excluding slow-tick demobilization. In R1,
opening-war aggressors average 27,452 unavailable manpower across their episode
versus 187.9 direct war damage; defenders average 26,021 versus 164.0. These are
separate opposing roles, not an aggregate quality score. Organization-collapse
removals explain why direct damage alone is an inadequate national cost budget.
The independent observer also covers amphibious loss in that fast-tick interval;
production spending is reported separately and excludes recovery, trade and aid.

## R2.4: observed national force costs (pending)

Add an opt-in ledger for actual direct damage and remaining manpower/equipment
removed with a defeated formation, including embarked cargo. Record observations
without changing damage, organization, removal, income, production cost or peace
rules. Normalize the budget by manpower committed at campaign opening and retain
costs through continuous concurrent wars, clearing the ledger once the nation is
at peace. Compare the ledger against the independent observer; disclose missing
loss paths instead of claiming complete coverage. No new final seeds are used.

R2.4 cost audit: the campaign ledger matches the independent field-loss observer
for every nation in all 16 diagnostic episodes, including sea cases, within
floating-point tolerance (1e-5 manpower). This verifies the observed paths, not
every possible future removal path. 685 regression tests, production build and
quick benchmark pass. The 100-row development trial and disabled-control replay
are being evaluated before any adoption claim.

### Normal-play experimental access

Added an unchecked, non-persistent switch inside the existing debug settings and
a bounded screen-space national summary. Verified through normal Japan-scale
startup: enable the experiment and strategic summary, advance to real autonomous
wars, observe candidate scores, military/political objectives, operations and
terminal history, pause, and pan the map while the summary stays visible. No
fixture or hidden game-state injection was used. The screenshot
`diagnostics/war-ai-r2-normal-strategy.png` records this normal-play path.
This UI observation verifies integration and visibility, not statistical quality.

### R2.4 development result: not adopted

Source `ef09122`, 100 candidate and 100 disabled-control episodes complete with
no failures. All actual settings and starting summaries match; every disabled
end-game summary and war outcome matches the earlier Legacy reference exactly
after excluding CPU timings. The added battle observations do not change the
control's rules or trajectory.

Active-war attacker retention is 20% versus Legacy 37% and R1 36%; defender
retention is 66% versus 44%/46%. Stalemate attacker retention remains 45% versus
65%/60%, and transfers are 106.7 versus 75.4/88.4. These are material unresolved
tradeoffs, not an overall improvement. Two-island landings/lost transports are
27/15 versus Legacy 48/51 and R1 43/35 in this matrix's initialization conditions;
fewer losses alongside fewer landings is insufficient evidence of better final
political results. Do not mix these counts with the differently initialized R1
forecast-only diagnostic (37/31 landings). New final seeds remain untouched.

Next diagnostic hypothesis: the political-purpose adapter currently treats an
un-cedeable capital as coercion worth only a small weapon concession. It may be
ignoring the separate, existing military-victory path to legal ownership. Audit
that classification and the alternative benefit estimates before changing them.
