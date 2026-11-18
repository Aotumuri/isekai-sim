# R2.21: shared ownership of a threatened capital's existing guard

Preregistered before implementation/outcomes. Paired seed-792 observations
show three combat-capable units on the capital at 200 in both R1/R2.20, then
an empty candidate capital from 226 and relief ordered too late at 361.
No repeated movement-progress reset explains that route. Source review also
finds front/zone defense floors and retained targets, but no common ownership
of an effective capital garrison. These facts motivate a test, not a claim
that one reservation solves every defeat or that old retreat luck is good AI.

Create an isolated candidate from canonical `29fa088`, retaining its existing
controller/march and omitting R2.20 fuel changes. Only experimental, automated
governments at war participate. While the existing capital assessment is
threatened/critical, reserve one currently effective, otherwise uncommitted
land unit already physically on the unoccupied owned capital. No teleporting,
new unit, resource grant, diplomacy change, cross-front extraction or blanket
attack prohibition. If none exists, do not pretend protection is possible.

Use existing combat strength for effectiveness/ranking, stable ties and no RNG.
Keep the assignment in existing capital-defense state, bounded by nations,
and expose it to campaign/debug observations. Consume that same assignment
in movement and competing offense/reserve/amphibious eligibility, rather than
adding independent guard choices. Manual orders, manual governments, retreat,
reorganization and existing special missions override eligibility. Revalidate
live ownership/capital/mission status; release on ended war, vanished threat,
capital change, invalid unit or changed player control. Do not trap an exhausted
unit indefinitely or prevent recovery. Forecasts must respect the guard's
unavailability for foreign offense while retaining its defensive contribution.

Before comparisons, require meaningful integration regressions (including
one failing parent behavior), manual/off/mission/cleanup and deterministic
checks, full tests/typecheck, build and quick smoke. Archive complete patch
and source hashes. First compare the same three 20-seed development families
as R2.20 (matched-war, stalemate-breaker, reorganization-heavy; 822748319780–799;
10,000 ticks; unchanged full-system political rules, normal wars, 640x360).
Use canonical/R1/Legacy references with identical starts/external goals.
Keep R2.16's original arms/seeds and all final seeds untouched.

Report own role's fixed opening goals, legal gains, survival/government,
losses and costs separately, paired 95%/10,000 bootstrap and observer parity.
Guard retention has a real offensive opportunity cost: improved survival by
indiscriminately ceasing attacks does not pass. Respect existing emergency
protection and role ownership; no large unrelated refactor. The candidate
remains isolated/default-off and the PR Draft until full adoption gates pass.

## Frozen candidate

The resumed worktree matched the recovery patch before editing. Candidate
`8c8f9301b245517bd4843a3332ab129118bade90` (production tree
`8a863ede0f6fa65ea9665e9e9b82870091c1d124`) extends that implementation.
It clears a reservation when the last land unit disappears and excludes the
guard from collapse-advance selection, including its empty-sector fallback.
The forecast withholds the guard from foreign projection and credits its
defensive strength only against a threat to that capital. Controlled player
nations are excluded in every command mode.

[The frozen patch](../diagnostics/war-ai-r2-21-capital-guard.patch) applies to
`29fa088`. SHA-256 is
`c1743fe127c9c97d77182fcdd38f3aa372b567020ce5116e3c6ee7f35039be53`.
The parent fails the primary movement regression because its existing capital
unit keeps the march order to `meso-94`. The candidate clears that order at
the next movement pass while other units still move. The four added tests
cover movement-cache invalidation, reserve exclusion, player override,
disabled movement, mission/war/threat/capital/unit invalidation and stable
ties. All 725 regressions, typecheck, build and quick benchmark passed on Node
24.22.1. The smoke benchmark uses the normal default setting.

## Development result

All 60 matrix cases and 60 cost/government replays completed. The replays
match the matrix's recorded non-CPU end state and complete war history.
Government reports verify paired starting fingerprints and opening governments;
opening-war objectives also match in all three matrix comparisons. Two
10,000-tick disabled-mode stalemate pairs (780 and 792) match on recorded
non-CPU end state, complete war history, and capital transitions.

| Family | Canonical → R2.21 attacker goal | Canonical → R2.21 defender home retained | Canonical → R2.21 defender survival |
| --- | ---: | ---: | ---: |
| Matched | 35% → 30% | 65% → 65% | 80% → 85% |
| Stalemate | 50% → 30% | 35% → 60% | 55% → 75% |
| Reorganization | 45% → 35% | 45% → 55% | 60% → 85% |

Stalemate home retention gained 25 pp [10, 45] versus canonical.
Reorganization survival and opening-government preservation gained 25 pp
[5, 45]. Stalemate survival equalled R1 at 75% [−15, 15 pp difference].
Home retention improved over both R1 and Legacy in Matched and Stalemate,
with paired intervals above zero. The retained-home gain against R1 in
Reorganization was 30 pp [10, 50]. Attacker goal completion fell against
R1 by 30 pp [−55, −5] in Stalemate and 25 pp [−45, −5] in Reorganization,
and against Legacy by 35 pp [−55, −15] in Stalemate. The attacker also lost
legal net territorial value against canonical in Stalemate (−14.8 pp
[−30.7, −0.5]) and Reorganization (−12.8 pp [−24.5, −3.0]), normalized by
opening territorial value. Endogenous and censored wars remain in the
paired reports. All opening wars resolved in this comparison.

Matched defender opening-war casualties decreased by 30.0 [−51.6, −9.9]
against canonical. Stalemate defenders used 11,411 production-recorded fuel
on average across the episode versus 6,868 for canonical (paired change
[−713, +11,810]) and 5,661 for R1 (paired change [+113, +13,640]).
Stalemate and Reorganization created 1.7 and 2.4 more operations on average
across the episode than canonical, respectively. The totals include later wars.
Canonical and R2.21 used the same Node build; median process CPU was 9.9%,
4.7%, and 5.7% lower in the three families. These totals reflect different
trajectories. R1/Legacy matrix runtime metadata is missing. Intrinsic
decision cost and long-run memory were outside this comparison.

## Selected mechanism replays

[Validation](../diagnostics/war-ai-r2-21-validation.json.gz) covers the cost
replay and ten capital traces. The traces are read-only, sampled after each
fast tick and any due slow step. Threat refers to the existing assessment.
A capital is treated as empty when no friendly land unit on the opening
capital has positive `getUnitCombatStrength`. Fuel is recorded independently
because the helper reads unit state rather than the resource balance.
Fuel-dependent units can already reflect shortages through zero combat power. Each pair below uses
the shorter opening-war horizon, with an exclusive right endpoint.

| Stalemate seed suffix | Common horizon | Threatened and empty, canonical → R2.21 | First loss of capital, canonical → R2.21 |
| --- | ---: | ---: | ---: |
| 780 | 396 | 174 → 132 ticks | 284 → 404 |
| 790 | 394 | 292 → 46 ticks | 302 → held through peace |
| 792 | 376 | 198 → 48 ticks | 376 → held through peace |

In 792 the common threatened horizon was 366 ticks. Both engines had the
same three defending units at tick 200. R2.21 reserved unit-61 at 210, cleared
its departure order by 211, and still held it at the capital when the
parent's garrison had left by 226. The opponent's operation was still
exploiting the same target at 211. The candidate ended the opening war alive
with its home retained at 410. Later enemy choices diverged; the trace
establishes local retention, with other effects still in play. In 780 the
candidate eventually lost the capital and survived the opening war.

The attacker's own capital guard was active before the missed first
objective in each of Matched 784 (ticks 10–309), Matched 792 (90–301,
310–313, 340–409), and Stalemate 790 (10–409). The Stalemate 792 attacker
never received a guard. These observations motivate a role control; exposure
alone cannot attribute the attack regression.

R2.21 is **rejected for integration**. The local retention mechanism helped
in the selected replays, with material attacker regressions and extra
defensive fuel cost in the paired comparison. The source and data are
preserved. [R2.22](AI_R2_CAPITAL_GUARD_ROLE_CONTROL.md) isolates the attacker's
own reservation from the opponent's improved defense to test that tradeoff.
