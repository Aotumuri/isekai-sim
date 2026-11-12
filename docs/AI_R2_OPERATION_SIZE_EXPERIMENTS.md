# R2.18: separate early strategic focus from major-operation size

Preregistered after R2.17, before variant implementation and results. No
R2.16 conditions or final seeds change. This addresses the measured
concentration/execution coupling, not an immediate patch for new user
observations about opportunism, early peace or puppet maintenance.

R2.16/17 and six parity-checked focus traces show that early campaign focus
changes the existing operation force fraction from ordinary 0.6 to major 0.9
even when the operation is explicitly not a major offensive. It can help or
hurt: selected seed 794's larger operation succeeds, while 783 cancels and
later outcomes diverge. Do not assume smaller operations or waiting are always
better. No coefficient tuning is proposed.

Hypothesis: strategic focus is an allocation priority, not sufficient evidence
for committing the major-operation share of surplus. A campaign-requested
focus below natural selection pressure should keep the ordinary operation
fraction. Once natural pressure sustains the focus, preserve existing major
fraction behavior. Natural concentration, major threshold, route feasibility,
front defensive floors, reserve/recovery/manual/capital protections, cooldowns,
targets and preparation requirements remain unchanged. AI off must retain
existing sizing even if stale diagnostic campaign-request flags are present.

Two frozen variants, each compared to its archived parent:

1. Canonical scored source `29fa088` with only this sizing change.
2. Diagnostic both-sided selection source `fb53ad9` with only this sizing
   change, to expose the mechanism under more frequent early focus requests.

The second variant is a mechanism control, not a candidate replacing scored
selection. Both are isolated source experiments; do not activate globally.
Use matched/stalemate/reorganization, all 20 already observed development
seeds, full systems/political turbulence, normal wars, 640x360, 10,000 ticks.
Record patches and hashes, typecheck/build, regression coverage for campaign
off, early request, natural takeover and emergency protection, then matrices.
Require identical starts and report both roles' goals, survival, legal gains,
duration/censoring and costs with existing paired bootstrap intervals. Keep
whole-episode losses/spending distinct from opening-war outcomes. Do not infer
quality from reduced costs alongside weaker national results, nor CPU gains
from concurrent runs. Any adoption still requires the unchanged full protocol.

## Completed development result

Both 60-case matrices completed with zero failures and exactly matching start
summaries/settings against their own parents. Candidate sources remain isolated;
canonical production is unchanged.

| Variant | Family | Attacker goal | Attacker survives | Defender homeland | Defender survives |
| --- | --- | ---: | ---: | ---: | ---: |
| Scored + ordinary early size | Matched | 30% | 100% | 65% | 80% |
| Scored + ordinary early size | Stalemate | 50% | 95% | 35% | 55% |
| Scored + ordinary early size | Reorganization | 40% | 95% | 55% | 70% |
| Selection + ordinary early size | Matched | 25% | 100% | 65% | 75% |
| Selection + ordinary early size | Stalemate | 55% | 100% | 35% | 65% |
| Selection + ordinary early size | Reorganization | 45% | 95% | 45% | 70% |

Against its scored parent, reorganization defender survival changes +10 pp
[0, +25], but attacker goal changes -5 pp [-15, 0] in both matched and
reorganization. Stalemate defender survival is unchanged for every paired seed,
so the statistically clear R1 deficit (-20 pp [-40, -5]) remains. No adoption.

Against its selection parent, stalemate attacker goal improves +20 pp
[+5, +40] and survival +15 pp [0, +30]; matched attacker goal declines -10 pp
[-25, 0], and reorganization goal -15 pp [-35, +5]. These are conditional
operation-size effects, not support for deploying the diagnostic selection
branch. The proposal keeps multi-approach planning unchanged; it does not
claim to separate every existing focus/major-offensive coupling.

Raw matrices, paired reports and safety/start validation are archived under
`war-ai-r2-18-*`. Both variants pass 723 full regressions plus the added
real-planner regression, typecheck, build and quick benchmark. The planner
regression fails under original sizing. Both whole-episode cost/government
replays also completed 60/60 cases, reproducing every common non-CPU end field
and full war outcome. Role-separated distributions and paired intervals are
in `war-ai-government-r2-18-{scored,selection}-v-parent.json.gz`; raw replays
and validation are archived. Lower expenditure alone cannot override the
retained safety deficit. No final seeds or R2.16 conditions changed.
