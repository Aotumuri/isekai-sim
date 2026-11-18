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
