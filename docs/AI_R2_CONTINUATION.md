# R2 continuation checkpoint

## 2026-11-14 resume update

R2.19's matrix and all three observation sets are complete (40 cases each),
with exact replay parity. Reports and the controller interaction are saved;
see AI_R2_MARCH_CONTROLLER_CONTROL.md. No adoption: stalemate defender survival
falls 75% to 60% against R1 despite reduced travel loss. Current work is the
paired seed-780 causal lifecycle trace (R1 versus R1+continuity); 790/792 are
other selected new defeats. Older pipeline descriptions below are now archives.
Use at most **one** Luna-low sub-agent for bounded checks/log summaries, as
requested by the user; do not spawn additional agents. Parent summaries must
use fixed opening-war metrics, not all-war averages. Source changes/final seeds
remain frozen. GitHub still reflects 8ecc90a: transport attempts failed, and
the last API retry was not executed because approval review hit a usage limit.
Do not bypass that review. Local commits/results remain available.

Git transport subsequently recovered: ec8f83a was pushed and Draft PR #2 was
updated on 2026-11-14. Seed-780 trace work now identifies the first capital
loss at 284, preceded by guard unit-48 disappearing at 281 after organization
falls to 0.035 despite ~1194 remaining manpower. Eight replay variants match
their references. Current next step is bounded code inspection of removal,
capital-defense selection and recovery, using the same single sub-agent.

The quality objective remains active. Completing a trial, tests or PR is not
project completion. Keep WarCampaign off by default and PR #2 Draft; do not
merge main or force-push. Adoption gates and untouched final seeds remain in
[AI_R2_PROTOCOL.md](AI_R2_PROTOCOL.md).

## Current source and checks

- `9d9c6e5`: opening relationship is snapshotted for already dependent defenders.
  721 tests, build and quick benchmark pass. Validation and before-fix failures
  are in `diagnostics/war-ai-r2-15-validation.json.gz`.
- `29fa088`: cost audit records first observed dependent defensive goals and
  immutable engine/source/harness provenance. Production source is the same.
- R2.16's original three-arm matrix is complete (180 cases, zero failures).
  [AI_R2_POLICY_EXPERIMENTS.md](AI_R2_POLICY_EXPERIMENTS.md) records results.
  No arm is adopted; do not alter this experiment or use final seeds.
- R2.14's matrix and four travel audits are complete: travel improves, but
  stalemate defender survival falls 20 points against R1 (95% interval −40 to
  −5). It is not adopted. The completed R2.15 scope audit matches all 16
  non-CPU results, with one actually exposed government-purpose correction.
- Five government/cost audits completed (300 cases), all with exact non-CPU
  end summaries and full war outcomes against observer-free references.
  Canonical full regression count is 723. Government metrics supplement the
  original gates; no gate is replaced.
- Two lifecycle traces distinguish peaceful subject integration from a real
  subject defeat during a parent/enemy truce. See
  [AI_R2_POLITICAL_OBSERVATION.md](AI_R2_POLITICAL_OBSERVATION.md).
- Next: causal traces of selection's stalemate defender rescues (783, 792,
  793) and new defeat (794), alongside actual settlement/maintenance valuation
  gaps. Do not deploy the unscored control blindly.

## Frozen ongoing comparisons

Current active experiment: **R2.19**, preregistered in
[AI_R2_MARCH_CONTROLLER_CONTROL.md](AI_R2_MARCH_CONTROLLER_CONTROL.md).
R2.18 completed both 60-case matrices and both exact 60-case cost/government
replays. Neither operation-size variant is adopted. Its conditions are in
[AI_R2_OPERATION_SIZE_EXPERIMENTS.md](AI_R2_OPERATION_SIZE_EXPERIMENTS.md).
R2.17 completed 120 matrix cases and 120 cost/government replays, with zero
failures and exact reference outcomes. No role control was adopted; see
[AI_R2_POLICY_CAUSAL_FOLLOWUP.md](AI_R2_POLICY_CAUSAL_FOLLOWUP.md).
R2.16 and all older comparisons below are completed archives.

- R2.19 source: `/private/tmp/isekai-r2-19-r1-march`, HEAD `a8510bb`;
  source tree `f2143c1b29f388e4b58c5ca4beecbde65fcbf629`. It applies only the
  archived march patch to R1, plus matrix runtime metadata. 673 inherited and
  march regressions, typecheck, build and quick benchmark pass. Production
  root remains unchanged/off; root diagnostic regressions now total 724.
- `war-ai-r2-19-r1-march.patch` applies to public `e6245a1`. Its original
  production tree exactly matches archived `93ba1cf`. The 40-case Legacy/R1
  references are filtered unchanged from the original 260-case matrices.
- Two sequential pipelines keep at most two simulations active. Pipeline A:
  frozen-engine matrix with `--campaign --full-systems --political-turbulence
  --normal-wars --observe-wars --ticks 10000 --seeds 20 --scenarios
  stalemate-breaker,reorganization-heavy`, output root
  `diagnostics/war-ai-r2-19-development.json.gz`, log
  `/private/tmp/isekai-r219-matrix.log`; after success it runs the root cost
  audit with `--engine-root /private/tmp/isekai-r2-19-r1-march --campaign
  --ticks 10000 --seeds 20 --seed-start 822748319780 --scenarios
  stalemate-breaker,reorganization-heavy`, output
  `diagnostics/war-ai-government-r2-19-development.json.gz`, log
  `/private/tmp/isekai-r219-cost.log`.
- Pipeline B: root travel audit with the same ticks/seeds/scenarios and
  `--campaign`, first against `/private/tmp/isekai-r1-e6245a1`, then against
  the R2.19 engine. Outputs `war-ai-r1-physical-travel-audit.json.gz` and
  `war-ai-r2-19-physical-travel-audit.json.gz`; logs
  `/private/tmp/isekai-{r1,r2-19}-physical-travel.log`.
- Do not mutate either engine or root cost/government/travel measurement files
  while queued pipelines run. All outputs save atomically and check hashes.
  Validate all replays with `war-ai-replay-validation.ts`; use the two-arm
  form of `war-ai-travel-report.ts BASELINE CANDIDATE OUTPUT` and original
  paired national reports. New same-front physical travel view supplements
  unchanged original metrics. Old four-arm reports reproduce exactly.
- Exact peace publication/acceptance observations are complete for four
  selected experimental cases and preserve reference outcomes. Results and
  pending Legacy/R1 scope are in
  [AI_PEACE_DECISION_OBSERVATION.md](AI_PEACE_DECISION_OBSERVATION.md).
- A GitHub push timed out during SSL connection. Local commits/data are saved;
  a bounded retry may still be active. Verify its outcome before another push,
  then update the existing Draft PR. This does not block local quality work.

- R2.18 scored variant: `/private/tmp/isekai-r2-18-scored`, HEAD `19ce4ea`.
- R2.18 selection mechanism control: `/private/tmp/isekai-r2-18-selection`,
  HEAD `10b0d05`. Both source+test patches apply to public `29fa088` and are
  archived under `diagnostics/war-ai-r2-18-{scored,selection}.patch`.
- Each passes 723 full regressions plus one added real-planner regression,
  typecheck, build and quick benchmark. The real-planner regression fails with
  the original sizing. Canonical production has not changed.
- Matrices use the same arguments listed below, outputting
  `diagnostics/war-ai-r2-18-{scored,selection}-development.json.gz`; logs are
  `/private/tmp/isekai-r218-{scored,selection}.log`.
- Parallel cost/government replays use the root `war-ai-cost-audit.ts` with
  `--engine-root` set to each frozen source, `--campaign --ticks 10000
  --seeds 20 --seed-start 822748319780 --scenarios
  matched-war,stalemate-breaker,reorganization-heavy`, output
  `diagnostics/war-ai-government-r2-18-{scored,selection}-development.json.gz`.
  Logs: `/private/tmp/isekai-government-r218-{scored,selection}.log`.
- Do not edit these engines or the root cost/government observers while active.
  Validate replays with `war-ai-replay-validation.ts`, compare each variant
  against its own R2.16 control/selection parent with `war-ai-report.ts`, and
  use the government report for distinct whole-episode costs. Continue causal
  improvement if gates fail; no completion or adoption is implied by tests.

- Aggressor-only control: `/private/tmp/isekai-r2-17-aggressor`, HEAD `afddf82`.
- Defender-only control: `/private/tmp/isekai-r2-17-defender`, HEAD `932aaf3`.
- Each variant passes typecheck, 20 targeted protection/budget/government/
  march/readiness tests and build. These are diagnostic source controls;
  canonical production remains unchanged and off by default.
- Both run `war-ai-matrix.ts --campaign --full-systems --political-turbulence
  --normal-wars --observe-wars --ticks 10000 --seeds 20 --scenarios
  matched-war,stalemate-breaker,reorganization-heavy`, outputting root
  `diagnostics/war-ai-r2-17-{aggressor,defender}-development.json.gz`.
  Logs: `/private/tmp/isekai-r217-{aggressor,defender}.log`.
- Resume from the matching frozen checkout with the same options and absolute
  output path. Never mutate an active engine. Compare with original R2.16
  control/selection before proposing a behavior change. Final seeds untouched.

All current experiment outputs use atomic saves, including the cost audit.
Do not edit a frozen engine while its run is active.

- R2.14: `/private/tmp/isekai-r2-14-march`, HEAD `b488da5`; same production source
  as main-worktree commit `c61f7c0`. The 5-family/20-seed/10,000-tick matrix saves
  `diagnostics/war-ai-r2-14-development.json.gz`. Log:
  `/private/tmp/isekai-r2-14-development.log`.
- Four travel audits: Legacy-equivalent and R1 use
  `/private/tmp/isekai-r1-e6245a1` (campaign off/on); R2.13 uses
  `/private/tmp/isekai-r2-13-cb71f68`; R2.14 uses its frozen checkout above.
  Run `test/diagnostics/war-ai-travel-audit.ts --engine-root PATH`, adding
  `--campaign` for enabled arms. Defaults: 20 development seeds, 10,000 ticks,
  stalemate/reorganization. Supply the matching output path
  `diagnostics/war-ai-{legacy,r1,r2-13,r2-14}-travel-audit.json.gz`.
- Only movement-phase audits are authoritative. Earlier frame-end partials
  are archived and rejected by the report, because slow updates after movement
  misclassified mission continuity. Preserve those failed measurements.
- Fresh R2.15 scope: frozen R2.14 versus
  `/private/tmp/isekai-r2-15-29fa088`, diagnostic seeds 1022748319784–787,
  four land families, 10,000 ticks. Saves `war-ai-r2-15-before-scope.json.gz`
  then `war-ai-r2-15-after-scope.json.gz` in diagnostics; log:
  `/private/tmp/isekai-r2-15-scope.log`. Check physical parity in unexposed cases
  and inspect genuinely dependent goal adoption separately.

## Runtime and next checks

The default Homebrew Node 26 cannot load its removed simdjson library. Use
`/opt/homebrew/opt/node@24/bin/node` (24.22.1) consistently. For npm also prepend
`/opt/homebrew/opt/node@24/bin` to PATH. Worktrees link the existing node_modules.
Do not compare speed across the old Node runtime or from concurrent wall times.

When complete, pair the new matrix against Legacy, R1 and R2.13 using
`war-ai-report.ts`. Pair the four complete travel audits with
`war-ai-travel-report.ts` and verify non-CPU outcomes/end summaries against
observer-free matrices. Keep exposure denominators and opposing interests
separate. Archive completed raw reports, document adoption or rejection, push
the existing branch and update the Draft PR. Continue causal iteration if the
quality gates fail. Full 13-family, fresh-final, default-map and long-soak checks
remain necessary before adoption; none is waived by this checkpoint.
