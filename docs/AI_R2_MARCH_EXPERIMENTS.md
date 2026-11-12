# R2.14: continuity within an unchanged ordinary march (preregistered)

The broad R2.1 travel-continuity prototype reduced redundant resets but did not
pass national quality gates. It is not adopted. Do not assume that its survival
regressions were caused by a particular mission class without evidence.

Existing traces expose a narrower, testable contradiction: a distant target
changes while the next legal movement edge, assigned front and campaign
revision remain unchanged. Excluding reserve/recovery/retreat/operation contexts
in the trace leaves 1,110 candidate resets / 770.6 discarded seconds in the
R2.5 stalemate case, 116 / 103.4 seconds in its active case, and 5,967 / 3,655.4
seconds in the R2.2 reorganization case. These are selected diagnostic traces,
not independent measurements of a general benefit. Their old context does not
fully classify amphibious ownership or manual orders.

Test a conservative integration: retain progress only on the same validated
first edge after a distant retarget, within an unchanged ordinary front march.
Bind the old edge to the preceding movement pass's front and campaign revision;
require that same mission before and after assignment. Exclude direct commands,
amphibious ownership, active operations, reserves, retreat, reorganization,
capital emergencies and vanished fronts. A different edge, stopped movement,
new mission or invalid route retains normal reset behavior. Enemy-blocked
arrivals still consume/reset progress normally; no battle, speed or path rule
changes. Keep the feature off with WarCampaign. Retain a bounded world-scoped
mission snapshot and clear it when disabled.

Verify routing, mission transitions, emergency/manual exclusions and cleanup;
run the full tests/build/quick checks. Measure actual discarded ordinary
same-edge progress under the same classification in Legacy, R1, R2.13 and the
prototype, alongside the unchanged five-family development outcomes and costs.
Do not call all target changes or allocation changes waste. Keep the original
adoption gates and final seeds untouched; fewer discarded seconds alone does
not establish national quality.

Travel measurement uses a read-only endpoint observer for all four arms, first
on the same 20 development seeds in stalemate/reorganization. Exclude an edge
blocked by an enemy at either endpoint, and measure lost elapsed time rather
than counting blocked entry as wasted movement. Report unchanged ordinary
mission retargets and losses, total ordinary travel exposure, and all unblocked
same-edge retargets/losses regardless of mission. The latter prevents a change
in mission classification from silently hiding resets. Show both absolute
seed distributions and exposure denominators/rates; fewer events due solely to
shorter wars or less movement are not sufficient. Check non-CPU outcomes and
end summaries against observer-free matrices. Preserve engine source tree,
harness/observer hashes and runtime; incremental output must reject mismatches.

### Measurement phase correction

The initial travel observer sampled after the whole fast/slow tick. A slow
campaign revision can occur after movement, making the preceding edge appear
bound to the new plan; a later reset is then misclassified as an unchanged
mission. Observing after battles can also miss the enemy that blocked entry.
The four incomplete frame-end audits are preserved as `travel-frame-partial`
files and are not adoption evidence. Their completed rows preserve physical
outcome parity, but that does not validate their mission classification.

Restart the travel audit at the existing `repositionUnits` instrumentation
boundary, after movement but before battles and slow strategic updates. This
uses the same phase for all four frozen engines and does not alter production
code. Keep outcomes at the normal diagnostic boundary for parity comparison.
Record this phase explicitly, reject old outputs on resume/reporting, and
recheck paired physical outcomes. No adoption thresholds or seed ranges change.
