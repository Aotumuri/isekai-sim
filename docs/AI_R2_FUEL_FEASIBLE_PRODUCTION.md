# R2.20: fuel-feasible wartime land recruitment

Preregistered before implementation and outcomes. R2.19's selected seed-780
trace found zero-fuel, zero-combat-power capital and nearby units in both R1
and the march control. This is a capacity constraint, not proof that a guard
was ignored. Existing recruitment checks material affordability and randomly
chooses infantry/tanks, without checking the extra tank's operating fuel.

Create an isolated candidate from canonical `29fa088`, retaining its existing
march continuity and controller, without changing diplomatic/combat/fuel rules. During an existing
experimental AI war campaign only, bound extra tank upkeep by remaining fuel
plus this production pass's fuel income minus existing next-pass upkeep.
Deduct newly recruited tanks' upkeep from that same budget within the batch.
This is a one-production-pass feasibility projection, not a claim of indefinite
sustainability. Use existing national design fuel modifiers. Preserve the
ordinary material choice's random draw; replace a selected infeasible tank
with affordable infantry, otherwise defer that unit. Do not prevent infantry,
alter navy priorities, reserve extra resources, grant income, or issue orders.
Disabled mode and manual governments retain the original choice.

Before comparison, require an integration regression that fails on the parent,
budget/no-double-spending/design/off/manual checks, full inherited regressions,
typecheck, build and quick benchmark. Archive source patch/hash and metadata.
Then compare matched-war, stalemate-breaker and reorganization-heavy on
all 20 existing development seeds 822748319780–799, 10,000 fast ticks, unchanged
640x360 full-system settings, against frozen canonical, R1 and Legacy cases.
Do not use final seeds. Existing R2.16 conditions and outputs remain unchanged.

Report fixed opening-war attacker goals and defender survival/home outcomes,
separate own legal gains/costs and whole-episode resource/government outcomes,
paired 95%/10,000 bootstrap intervals and replay parity. No improvement claim
from one selected rescue, extra production alone, or summed opposing utility.
If no material exposure or safety/goal regression occurs, report it rather
than broadening the policy after inspecting seeds. Default remains off and
the PR remains Draft. Any application to a different controller is another experiment.

## Frozen candidate

Candidate `3aa0ba7`, production tree
`67375fd0ebed0b7e9a2788d90b09a78416c86048`, is isolated in
`/private/tmp/isekai-r2-20-fuel-feasible`. Its complete patch and validation
record are archived as `war-ai-r2-20-fuel-feasible.patch` and
`war-ai-r2-20-source-validation.json.gz`. Six added tests exercise actual
recruitment, design-adjusted batch accounting, ordinary random draws,
disabled/manual behavior and the one-pass budget. The original production
implementation fails the behavioral regression. The candidate passes all
727 tests, typecheck, build and the ordinary quick benchmark. The latter is
only a smoke check, not enabled-policy quality or intrinsic timing evidence.
The 60-case quality and matching cost/government replays are next; no adoption
or improved national outcome is claimed from passing tests.

Documentation clarification: canonical `29fa088` already contains R2.14's
march continuity. The frozen patch changes only recruitment fuel feasibility;
it neither introduces nor removes that inherited movement behavior. The
preregistered parent, candidate source, settings and seeds are unchanged.

## Completed first comparison: not adopted

All 60 matrix cases and 60 cost/government replays completed without failures.
The matching replays have identical common non-CPU end summaries and complete
war outcomes. Reference starts/external goals match; Legacy differs in its
intended disabled campaign setting. Original matrices are unchanged.

| Family | Canonical attacker goal → candidate | Canonical defender survival → candidate |
| --- | ---: | ---: |
| Matched | 35% → 30% | 80% → 80% |
| Stalemate | 50% → 45% | 55% → 60% |
| Reorganization | 45% → 40% | 60% → 65% |

Each attacker-goal difference against the canonical parent is -5 pp
[-15, 0]. Against R1, defender-survival differences are +10 pp [-15, +35],
-15 pp [-30, 0] and -5 pp [-20, +10], respectively. These intervals include
zero; neither the selected rescue nor altered composition establishes an
improvement. The material stalemate survival concern remains. Whole-episode
production-recorded fuel use changes substantially but is not a substitute for national
goals, survival, or role-specific costs. This candidate is not adopted, and
passing tests does not resolve its strategic shortcomings.

In the selected changed stalemate seed 822748319786, the canonical aggressor
holds its goal and the defender dies at 422. The candidate ends that war at
410 with the aggressor goal unmet and the defender alive/home retained. The
same case therefore supplies both a rescue and an opposing goal loss; do not
count them as independent general improvements. Next inspect actual offers,
campaign choices and military capacity at that divergence, without another
fuel coefficient change or a diplomatic-rule change.
