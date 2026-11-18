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

## R2.14 result: travel improves, national adoption rejected

Source `b488da5` (same production tree as `c61f7c0`): 717 tests, build and quick
benchmark pass. The independent observer adds two passing tests. All 100
development episodes finish without failures. Attacker retention is
29/35/50/45/0% in active/matched/stalemate/reorganization/sea; defender survival
is 74/80/55/60/100%. Stalemate defender survival is 20 points below R1,
paired 95% interval −40 to −5. Attacker retention in that family is also below
R1 (−10 points, −30 to +10). Reduced travel does not justify this safety loss.

All four movement-phase audits finish, 40 episodes each. Every recorded
non-CPU end summary and full war-outcome report matches the observer-free
reference (160/160). Average discarded ordinary movement time, summed across
units per episode, is:

| Family | Legacy-equivalent | R1 | R2.13 | R2.14 |
| --- | ---: | ---: | ---: | ---: |
| Stalemate | 345.965 s | 362.220 s | 364.450 s | 26.045 s |
| Reorganization | 545.250 s | 279.380 s | 363.580 s | 12.735 s |

Against R1, the paired ordinary-time differences are −336.175 seconds
(−538.855 to −171.375) and −266.645 (−403.180 to −149.000).
The broader all-unblocked time differences are also negative: −242.740
(−456.570 to −55.755) and −199.230 (−411.460 to −12.390).
Pooled ordinary discarded/travel exposure is 1.03% / 0.60%, versus R1
13.98% / 10.20%; the per-seed rate intervals also exclude zero. These are
summed unit times, not faster war resolution or saved computer wall time.

Ordinary counts are conditional on the observed campaign revision, which
Legacy lacks, so do not treat that conditional comparison alone as proof of
superior planning. The all-unblocked view and exposure rates are necessary
cross-checks; not every reset during a mission change is unnecessary. A common
physical-order context without the revision filter will supplement any future
adoption comparison. Keep this implementation experimental while investigating
the national policy deficit; do not enable it on the strength of travel alone.
