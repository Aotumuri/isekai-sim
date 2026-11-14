# R2.20: fuel-feasible wartime land recruitment

Preregistered before implementation and outcomes. R2.19's selected seed-780
trace found zero-fuel, zero-combat-power capital and nearby units in both R1
and the march control. This is a capacity constraint, not proof that a guard
was ignored. Existing recruitment checks material affordability and randomly
chooses infantry/tanks, without checking the extra tank's operating fuel.

Create an isolated candidate from canonical `29fa088`, without adding march
continuity or changing any diplomatic/combat/fuel rule. During an existing
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
the PR remains Draft. Any later combination with march is another experiment.

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
