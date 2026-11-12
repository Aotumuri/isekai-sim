# R2.16: policy-selection ablation (preregistered)

R2.14 fixes much ordinary march churn but leaves a statistically clear
stalemate defender-survival deficit against R1. Do not adjust casualty or
combat coefficients to hide it. The current model assigns no offensive return
to an unoccupied defensive homeland; the earlier forced-offense diagnostic
rescues some defenders but kills another and accelerates other defeats.
Neither universal offense nor an unlimited budget is supported.

Isolate the policy-selection rule from the surrounding R2 implementation:

1. Normal R2.15 source (`29fa088` production tree).
2. A diagnostic source variant uses the existing unscored policy branch for
   single-war campaigns. Keep forecasts/alternative scores recorded and keep
   the same scores in actual peace willingness. Apply the existing review
   interval/material guards, without score-driven early review in that branch.
   Its military fallback is offensive only for a limited-offensive decision,
   defensive otherwise. Preserve readiness, food/casualty/capital overrides,
   military-exit safeguards and all downstream protection. Multiple-war
   campaigns retain the current scored controller. No new coefficients.
3. The same variant additionally uses existing natural Schwerpunkt selection
   for single-war campaigns, rather than requesting an early campaign focus.
   Actual stand-down, emergencies, secondary defense protection, natural
   pressure and operation cooldowns remain unchanged.

These are diagnostic source controls, not a claim to reproduce R1: goal
contracts, cost observation, movement, shared recovery budget and actual peace
scoring remain R2. They distinguish replacing the selection/review rule from
the additional effect of proactive concentration. Do not attribute the whole
effect to one score term or to defenders alone; both governments respond.

Use all 20 development seeds in matched/stalemate/reorganization, full systems,
normal wars, 640x360 quick worlds, 10,000 ticks. Freeze each engine before
running; preserve source patches and hashes. Require identical starting
settings/summaries, determinism/legality and targeted safety checks. Compare
all three arms, then Legacy and R1 with the same external opening-war goals,
legal value, survival, costs, settlements and censoring. Keep attacker and
defender interests separate and use the existing paired intervals. This is
causal diagnosis; no final seeds or adoption thresholds change. If the older
rule works better, investigate model coverage/uncertainty rather than treating
an unmodeled benefit as a known zero or deploying a diagnostic switch blindly.

The user's 2026-11-13 observations are recorded separately in
[AI_NATIONAL_STRATEGY_OBSERVATIONS.md](AI_NATIONAL_STRATEGY_OBSERVATIONS.md).
They do not alter this three-arm experiment, conditions or reserved seeds.
