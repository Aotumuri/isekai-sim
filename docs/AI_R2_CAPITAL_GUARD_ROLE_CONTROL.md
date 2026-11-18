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
