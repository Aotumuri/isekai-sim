# R2 continuation checkpoint

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
- The last completed strategic matrix is R2.13 (`cb71f68`), 100 episodes;
  results and regressions are in [AI_R2_PEACE_EXPERIMENTS.md](AI_R2_PEACE_EXPERIMENTS.md).
- No later prototype has passed adoption. R2.14 remains under evaluation.

## Frozen ongoing comparisons

All experiment outputs use atomic saves except the small cost scope audit.
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
