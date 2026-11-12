# R2 peace-route and recognition experiments

## R2.12: bilateral exit must be executable (preregistered)

The campaign readiness check can report a mutually acceptable published offer
even when a faction charter prohibits separate peace. Actual acceptance rejects
the same offer. A regression test reproduces this disagreement before the fix.
Share the bilateral-route eligibility between opportunity forecasting and
readiness: normal diplomatic war, no active joint conference, no separate-peace
prohibition. Maturity, affordability, willingness and automatic-government checks
retain their existing responsibilities. Do not change the charter or acceptance
rules. Verify the negative case and a charter change at the same virtual tick;
run the full suite and diagnostic episodes. This correctness fix alone is not a
claim of overall strategic improvement.

The readiness path also returns early before the existing necessary minimum
peace age, avoiding offer scoring that cannot yet succeed. This uses the same
shared timing predicate and changes no maturity threshold or acceptance rule.

## Recognition frontier audit (preregistered, read-only)

Seven of nine identified development defender-survival regressions in the three
single-war land families have a territorial-concession purpose at the opening,
rather than a decisive-victory purpose. Check all 20 development seeds in those
three families for 2,000 ticks, recording censoring. When the aggressor holds its
legally cedeable adopted target, assess an exact recognition offer and the
minimum affordable weapon compensation that makes the recipient's willingness
score nonnegative. Check both sides separately under existing scoring, legality,
government and maturity rules. Distinguish currently executable bargains from
future willingness blocked by maturity, and record whether actual published
terms already cover the goal. Do not publish offers or change the simulation.
First verify observer parity on opening-war outcomes and use those observations
only to decide the next prototype. No final seeds or adoption gates change.

### R2.12 and frontier results

Source `c32b322` passes 710 tests and build. Sixteen diagnostic trajectories
match `ae50bd5` on all non-CPU results. The joint-peace charter regression
demonstrates a real readiness/acceptance disagreement, but these standard
diagnostics do not expose it; no strategic quality gain is claimed.

Source `3a3f2df`: all 120 audit episodes complete, with exact observer parity in
all 60 pairs. In matched/stalemate/reorganization, 7/8/12 episodes hold legal
adopted goals; 2/3/9 contain an unpublished goal. Only one matched episode has a
mutually executable recognition bargain, with zero compensation; no other
episode has mutual willingness even with affordable compensation. These are
episode counts, not independent repeated observations. Missing goal proposals
exist, but cannot explain most failures by themselves.

## R2.13: sovereignty differs from intact borders (preregistered)

The defender adopts the political purpose `preserve-sovereignty`, but its peace
value currently requires keeping every opening homeland district. A minor
cession removes the entire political recognition value, in addition to the
existing territorial cost. This confuses the military objective (defend the
homeland) with the political objective (retain an independent government).

Test one semantic correction: a surviving independent state that keeps its
capital can preserve sovereignty despite a peripheral concession. Puppet or
partition terms cannot secure that objective; an existing active overlord also
prevents independent sovereignty. Local subject terms retain the original
government's independence and continue to pay existing territorial/subject costs.
Use the same predicate for prospective peace value and terminal political
history. Keep all military targets, territorial costs, recognition weights,
automatic acceptance, legality, maturity and emergency protection unchanged.
Test actual territory transfer, occupation versus ownership, puppet government,
extinction and capital loss. Compare the same five development families with
R2.11, Legacy and R1. Internal history changes are not evidence of quality:
retain the unchanged external objective, legal territory, survival and cost
metrics. No final seeds or adoption gates change.

## Defender-effort causal diagnostic (preregistered)

In R2.11, nine development openings survive under R1 but lose the defender under
the prototype: stalemate 780/786/790, reorganization 780/789/790/792, matched
781/789 (suffixes of 822748319xxx). The forecast gives unoccupied homeland no
exposure value, so a defender has no modeled benefit from proactive investment
before invasion. Test whether this actually matters before introducing a threat
model. On the R2.13 source, replay these nine openings for 600 ticks in normal,
forced-defense and forced-limited-offense arms. Intervene only at the campaign
boundary while the opening war exists, without overriding capital, food, loss
budget or a negotiated exit. Keep lower-level emergency guards and battle rules.
Record actual intervention exposure, both sides' frozen opening-war outcomes,
independent force losses, production costs and episode-end survival. These
selected failure cases are causal diagnostics, not adoption evidence; 600-tick
unfinished wars remain censored. Do not infer that forcing one mode universally
is a suitable policy.

### Defender-effort result

Source `ecffda2`, 27 episodes complete. All nine normal/forced-defense pairs
match exactly on non-CPU outcomes, end summaries, independent force losses,
production costs and episode survival. Limited-offense intervention is exposed
in eight cases; the remaining matched case stays under protected conditions.
Three normally eliminated defenders survive the 600-tick episode under forced
offense, while one normally surviving defender is eliminated. Four other deaths
occur sooner. This supports studying the timing and location of investment,
but rejects a universal offense override. The normal R2.13 stalemate-780
defender already survives, unlike R2.11; full paired development evaluation is
still required before treating that individual case as a general gain.

### Objective-proxy limitation

Comparing R2.5's saved first-real-tick adopted goals with the unchanged neutral
benchmark goals gives exact target matches in 11/20 matched, 11/20 stalemate and
9/20 reorganization openings. The neutral proxy chooses the first border ID;
the planner values locations. These measurements are different questions.
Do not optimize the planner toward an arbitrary identifier to improve the
proxy, and do not silently replace the prespecified adoption gate. Continue to
report that proxy alongside legal territorial value, survival and costs.

