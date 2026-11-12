# WarCampaign R2 experiment history: R2.10 onward

Continuation of [R2.1–R2.9](AI_R2_EXPERIMENT_HISTORY.md).
Adoption gates and seed separation remain in [the protocol](AI_R2_PROTOCOL.md).

## R2.10: compare complete national portfolios (preregistered)

Current alternatives compare one opponent's benefit/cost while omitting the
other wars. A defensive option against an unthreatening opponent can therefore
outscore defending the endangered front simply because it ignores that front's
risk. Preserve the defensive baseline for all other wars in every candidate;
compare replacing one theater's effort with offense or settlement. Share the
observed national loss/replacement estimate across opponents rather than adding
the same national cost repeatedly; attribute current occupation to its actual
occupier rather than charging every war for the same lost land. Rank equal national defensive plans by local
exposure, with the existing periodic review, uncertainty and emergency override.
Peace continuation pressure must still use the relevant opponent's incremental
estimate, not the summed cost of unrelated wars. Test the portfolio accounting
and priority with independent counterexamples, then the same five development
families against R2.9, Legacy and R1. Leave actual orders, coefficients and final
seeds unchanged. Forward territorial exposure is a separate later test: current
risk uses only land already occupied; 623 noncritical diagnostic goal samples in
13 episodes have an outnumbered unoccupied border and zero defensive risk,
including 37 with zero projected available land force. Do not infer 623
independent failures or claim that every local mismatch requires an emergency.

### R2.10 result: not adopted

Source `3eabb3c`, 100 development episodes, no failures. Attacker retention is
28/40/45/50% in active/matched/stalemate/reorganization, defender survival
73/70/60/60%. R1 is 36/45/60/60% and 74/70/75/70%. Active retention's paired
interval against R1 is −16 to 0 points; a floating endpoint within machine
roundoff of zero is interpreted as zero, not evidence of exclusion. The
single-war deficits remain. 700 tests and build pass. A fresh disabled control
matches all 100 earlier control trajectories on non-CPU end summaries and war
outcomes, with identical initial settings/summaries between enabled/disabled.

The default Node executable subsequently could not load a removed simdjson
library. An installed Node 24.22.1 binary works. Sixteen frozen `7ebb111`
diagnostic trajectories reproduce all non-CPU results exactly under it, including
opening fingerprints, costs, settlements and outcomes. New harnesses record
Node/V8/platform/architecture and reject resuming a versioned matrix under a
different runtime. Do not compare timing across these runtimes. Fresh final
arms will use one consistent runtime.

## R2.11: execute investment through existing concentration (preregistered)

The earlier option probe exposed that nominal defense and offense can execute
the same actions. Restoring local counterpressure avoids an arbitrary border
ban, but leaves discretionary investment weakly connected to the scored choice.
The existing Schwerpunkt mechanism already concentrates allocations, reserves
and operation preparation; do not build a second focus or allocation system.
Test requesting that existing mechanism for the campaign's primary opponent
when the military fallback selects limited offense, without waiting for natural
stalemate pressure. Other opponents retain defense and local counterpressure,
but cannot simultaneously request discretionary concentration. Ordinary defense
keeps the existing reactive mechanism. Withdraw a campaign-only concentration
when its investment is withdrawn, unless natural stalemate pressure independently
justifies it. Preserve selection continuity, operation cooldowns, capital/retreat
overrides, and supply/capital demand floors on secondary fronts. Do not raise
simultaneous-operation limits or alter battle coefficients. Verify actual effort
distinction in the diagnostic counterfactual probe, then the same five families
against R2.10, Legacy and R1. Forward-exposure modeling remains a separate test;
no final seeds have been inspected.

### Execution probe and safety correction

Sources `8200755`/`8bac9af`: four diagnostic seeds × four families × three
interventions, 300 ticks. The same updated harness forces military effort with
offense/defense and preserves the negotiated mode's fallback. Opening force and
forecasts are identical in all 48 paired runs. Offense/defense produce different
measured actions/outcomes in 12/16 pairs versus 1/16 under R2.10; all four sea
pairs appropriately remain unchanged. This proves an execution distinction,
not better national quality. 704 regression tests and build pass at this stage.

Further inspection found emergency reason flags missing from allocation cache
inputs. An actual two-front allocation test fails on the frozen prototype when
only protection changes: the cached reduced secondary demand remains in use.
`dc5f955` records protection in that cache and preserves focused priority when
protecting demand. The test verifies actual demand restoration/removal for
capital, force-supply, corridor and bridgehead protection; it replaces a weaker
boolean-only test. The initial matrix was deliberately stopped at 68 saved
episodes (`war-ai-r2-11-pre-cache-fix-partial.json.gz`), rather than adopted.
705 full regression tests and build pass on the corrected source; its
100-episode matrix is running. The feature remains opt-in.

## Loss-exit diagnostic (preregistered, not a production change)

### Objective-distance performance follow-up (preregistered)

The profile identified repeated goal-distance BFS work. Its traversability uses
legal ownership and terrain, not occupation or unit positions. Cache one field
per active national war goal, invalidate on map/territory/target/opponent changes,
and prune ended goals or disabled campaigns. The cache is scoped to the world
through a weak reference. Require identical non-CPU diagnostic results against
the frozen uncached source before retaining it; measure fixed-state CPU with the
same Node 24 runtime. Unit tests cover actual third-party route blocking, changed
targets/terrain, occupation independence and cleanup. This is not a quality gain.

Test whether an exhausted field-loss budget suppresses useful local defensive
pressure before a mutually acceptable exit exists. Use four diagnostic seeds,
four land families, 10,000 ticks and three arms: normal; forced front review;
forced front review with only the opening defender's loss tolerance temporarily
removed during front-plan construction. Keep the national strategic decision,
food limit, peace readiness, capital/retreat/supply guards, battle rules and
every later consumer unchanged. Restore the tolerance immediately after the
front plans are built. First compare normal/review trajectories: if those differ,
do not attribute the difference to the budget intervention. Compare the two
review arms only as a causal diagnostic, never as evidence for adopting an
unlimited budget. Observe unavailable force independently and freeze opening-war
outcomes; record exposures rather than calling every hold a mistake.
