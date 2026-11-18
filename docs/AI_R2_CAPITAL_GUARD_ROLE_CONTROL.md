# R2.22: opening-war role control for the capital guard

Preregistered after [R2.21](AI_R2_CAPITAL_GUARD_EXPERIMENT.md) and before
running this control. R2.21 improved defender home retention while reducing
attacker objective completion. In Matched 784/792 and Stalemate 790, the
attacker had its own capital guard and missed even its first opening goal.
Stalemate 792 retained the defending government with no guard on the
attacking side. The observations allow two competing mechanisms: the
attacker's reservation may reduce its own force availability, and the
defender's reservation may independently make the same objective harder.

In a detached worktree derived from R2.21 `8c8f930`, require that the nation
be a defender in at least one active war when assigning or retaining a
capital guard. A government defending in one war and attacking in another
remains eligible. Leave the rest of the reservation, combat, movement,
diplomacy, and forecast model unchanged. Treat the role restriction as a
diagnostic intervention. An aggressor may still need ordinary capital
defense under the existing rules.

First replay the four named development cases for 10,000 ticks with the
same normal-war, full-system and political-turbulence 640×360 inputs.
Compare the opening roles against the fixed R2.21 and canonical references.
Verify absence of the attacker reservation before attributing changes in
first objective attainment. The control advances to the 60-case matrix only
if it restores first objective attainment in at least two of the three
misses and preserves survival and home retention in Stalemate 792. Also
check final holding and capital exposure to interpret any early restoration.
This targeted sample tests the proposed mechanism. Adoption needs the
unchanged protocol and separate evidence. Use development seeds only.

## Fixed source and targeted comparison

Candidate `51ebc2cf0ec8897d16b49576bf844a22700356bd` has production
tree `2f511128cc0f4a757d468c69ad456f3ef2373412`.
[Its source and test patch](../diagnostics/war-ai-r2-22-capital-guard-role.patch)
applies to R2.21 `8c8f930`, after restoring the R2.21 patch if necessary.
SHA-256 is
`1403e69cddfe390a5cc13b373d2b4c6e66d9ecbdc342ec5a2fdcfef9a15ab08e`.
The added test checks eligibility while attacking and defending in separate
wars and immediate release when only the attacking war remains. All 726
regressions, including typecheck, build and quick benchmark passed.

| Development case | First attacker goal, R2.21 → R2.22 | Attacker final goal, R2.21 → R2.22 | Defender survival / home, R2.21 → R2.22 |
| --- | ---: | --- | --- |
| Matched 784 | missed → missed | no → no | yes/no → yes/no |
| Matched 792 | missed → 510 | no → yes | yes/yes → yes/no |
| Stalemate 790 | missed → 338 | no → yes | yes/yes → no/no |
| Stalemate 792 | 246 → 246 | no → no | yes/yes → yes/yes |

The trace records no attacking-side reservation during the four opening wars.
Both role traces for each case exactly match the single-case matrix's recorded
non-CPU end state and war history. The preregistered gate passed (2/3 goal
restorations with Stalemate 792 still preserved). Stalemate 790 lost its
previous rescue, an early signal of an opposing-role cost.

The four matrices use the usual flags and `--seeds 1 --seed-offset N` with
`N = seed - 822748319780`, and the scenario named in the table. The full
comparison uses the same matrix, cost replay and paired analysis as R2.21.

## Expanded development comparison

All 60 matrix cases and 60 cost/government replays completed. Paired
starting fingerprints and opening goals match the frozen references. The
[validation record](../diagnostics/war-ai-r2-22-validation.json.gz) confirms
the 60 non-CPU end states and full war outcomes, plus the selected replays.

| Family | Attacker final goal, canonical / R2.21 / R2.22 | Defender home retained | Defender survival |
| --- | ---: | ---: | ---: |
| Matched | 35% / 30% / 40% | 65% / 65% / 55% | 80% / 85% / 75% |
| Stalemate | 50% / 30% / 40% | 35% / 60% / 45% | 55% / 75% / 65% |
| Reorganization | 45% / 35% / 45% | 45% / 55% / 45% | 60% / 85% / 65% |

Against R2.21, attacker final goals increased by 10 pp in every family.
Paired 95% intervals include zero. Ten cases regained an attacker goal
and four lost one. All ten gains coincided with a defender losing survival
or home retention (eight were extinctions). Reorganization defender
survival fell by 20 pp [−40, −5] against R2.21. Against R1, R2.22 improved
defender home retention in Matched and Reorganization by 20 pp [5, 40]
each. Against Legacy, Matched improved by 25 pp [10, 45] and the other
two intervals include zero. Stalemate attacker final goals declined by
25 pp [−45, −10] against Legacy, and defender survival was 65% versus
R1's 75% [−30, +10 pp difference].

Against canonical, median process CPU changed by −4.1%, −1.0%, and +4.3%
in the three families. These totals include trajectory differences.
Stalemate defender episode production recorded 9,293 mean fuel demand
versus 6,868 for canonical (+2,425 [72, 5,964]). The `war-ai-r2-22-v-*`
and `war-ai-government-r2-22-v-*` artifacts carry opening territorial,
casualty, government, cost and CPU distributions with 10,000 paired
resamples. Final-evaluation seeds are unused.

R2.22 is **rejected for integration**. Role gating reproduced some of the
offensive opportunity cost, with the recovered objectives accompanied by
defensive losses on the same seeds. Both guard variants remain isolated.

## Early defense failure in Stalemate 790

Two paired [R2.21](../diagnostics/war-ai-r2-21-relief-stalemate-790.json.gz)
and [R2.22](../diagnostics/war-ai-r2-22-relief-stalemate-790.json.gz) replays
sample tick 130–302 through the existing subject trace in operations mode.
In R2.21, three positive-strength units were already reorganizing at the
original capital, meso-72, at tick 130. Unit-63 was first reserved at 240
after it finished reorganizing. In R2.22, the capital had no positive-strength
unit through the window. The fuel-starved unit-48 had zero combat power.
The next reservation was at 310, on the relocated capital after meso-72 fell.

At 200, seven positive-strength units served the same front elsewhere.
Unit-55 and unit-56 were already at adjacent meso-68, with organization 0.30
and 0.21 (below the guard's 0.40 floor). Other units at meso-99 and meso-113
had nominal two-edge paths through meso-68 in the initial owned topology.
At 250, when the assessment turned critical, meso-68 was contested and no
defender was ordered to the capital. Unit positions and movement rates
establish potential earlier availability. Safe release from the front,
route access at decision time, and the consequence of diverting strength
remain unestablished. A further threshold change for stationary guards has
no support from this failure. Any relief intervention needs evidence of
arrival before enemy contact and an explicit comparison with the defense
it would vacate.
