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

## Development result (2026-11-13)

All original 180 cases completed, zero matrix failures. Start summaries and
settings match for all three arms. `war-ai-r2-16-validation.json.gz` records
source trees, patch hashes and application checks against public `29fa088`.
Diagnostic variants remain isolated; neither patch is enabled in production.

| Arm | Family | Attacker opening goal | Defender homeland | Defender survives |
| --- | --- | ---: | ---: | ---: |
| Control | Matched | 35% | 65% | 80% |
| Selection | Matched | 35% | 60% | 70% |
| Natural | Matched | 40% | 55% | 70% |
| Control | Stalemate | 50% | 35% | 55% |
| Selection | Stalemate | 35% | 60% | 65% |
| Natural | Stalemate | 50% | 35% | 55% |
| Control | Reorganization | 45% | 45% | 60% |
| Selection | Reorganization | 60% | 30% | 65% |
| Natural | Reorganization | 45% | 45% | 65% |

Paired 95% seed-bootstrap intervals (20 seeds, 10,000 resamples): selection
versus control changes stalemate attacker goal by -15 pp [-30, 0], attacker
survival by -15 pp [-30, 0], and defender survival by +10 pp [-10, +30].
Reorganization attacker goal changes +15 pp [-5, +35]. Matched defender
survival changes -10 pp [-25, 0]. Natural concentration reverses much of the
stalemate/reorganization selection effect, without consistent overall gains.
These controls do not justify a blanket rollback or universal offensive effort.

Six additional paired reports compare each arm with Legacy and R1 on the same
60 cases. Control and natural still have a stalemate defender survival deficit
against R1: -20 pp [-40, -5]. Selection's corresponding difference is -10 pp
[-35, +15], while its stalemate attacker goal difference is -25 pp [-50, 0].
No arm is adopted. All raw matrices and nine paired reports are archived under
`diagnostics/war-ai-r2-16-*`. Concurrent/historical CPU timings in those reports
are not controlled speed evidence.

Government observation is a separate supplement: 300 replays across Legacy,
R1 and the original three arms have exact non-CPU end summaries and full war
outcomes against their observer-free references. See
[AI_R2_POLITICAL_OBSERVATION.md](AI_R2_POLITICAL_OBSERVATION.md). No evaluation
gate, experiment condition or unused seed was changed.
