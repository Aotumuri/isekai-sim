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
