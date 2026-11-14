# Factual campaign-cost calibration pilot

Preregistered before new replay observations. The selected revision-delay
counterfactual produced extra losses without opening-war gains. It does not
justify forcing continued attack, nor prove the campaign forecast correct.
Its past loss-rate projection and diplomatic willingness use different scales.
Measure factual prediction error before adjusting coefficients or adding goals.

Use frozen canonical `29fa088`, campaign on, unchanged full-system development
fixtures: matched-war, stalemate-breaker, reorganization-heavy, seeds
822748319780–783, 10,000 ticks. These 12 selected development cases are a
measurement pilot, not a new quality/adoption population. No final seeds.

Read only existing campaign observations/alternatives and battle-cost state.
For opening-war nations, record slow-pass forecasts during the first 900 fast
ticks, then match each to a 300-fast-tick (30-second) future observation.
Keep the original casualty fraction, smoothed loss rate, projected defense/
attack resource cost, current military mode, force/manpower, resources and war
membership. Compare the original fraction's future increase only when the
same opening war, membership and denominator remain observable. Mark wars
that end, observations that disappear, and changed military modes/priorities separately;
do not impute zero cost after settlement or treat a changed policy as the
counterfactual outcome of an unchosen option. Stable mode is still an
observational subgroup, not randomized causal identification.

Require exact matching reference non-CPU end summaries and complete war
outcomes for all 12 replays. Archive observer hash, source metadata and raw
bounded forecasts. Report eligible/censored/changed counts, prediction versus
observed cost distributions separately by role and military mode, and timing
of formation removals versus direct manpower damage. Do not mix actual deaths,
unavailable formations and political cost tolerance. If coverage is inadequate,
report that limitation before extending the measurement. No gameplay changes.

## Pilot result

All 12 replays match their frozen reference non-CPU end summaries and complete
war outcomes. Four window-classification regressions cover interrupted modes,
denominator/membership changes and missing/ended futures; all 728 root tests
and typecheck pass. The observer, classifier and analysis hashes are retained.

| Opening role / military mode | Eligible windows / cases | Case-mean predicted / observed fraction |
| --- | ---: | ---: |
| Aggressor / defend | 200 / 8 | 0.170 / 0.457 |
| Defender / defend | 270 / 10 | 0.219 / 0.564 |
| Aggressor / limited offensive | 0 / 0 | unavailable |

Only identical eligible samples enter those prediction/observation averages.
All-origin forecasts, including censored ones, are stored separately. Within
these stable defensive subgroups the raw loss-rate extrapolation underpredicts
future unavailable-manpower fraction. It does not support lowering forecast
costs to make the AI fight longer. These are opening-investment fractions,
including removed formations, not percentages killed or fractions of current
national population/army. The overlapping windows are not independent cases.

All 60 offensive windows were censored. The pilot cannot calibrate continued
offense or adjudicate the selected 786 peace decision; that seed was not among
these four pilot seeds. Ending wars, changed membership/priorities/modes and
denominator changes remain visible as separate reasons rather than zero
future losses. Coverage is insufficient for an offensive-policy coefficient
change. Further measurement must preserve that limitation.

Reproduce the summary with
`node --import tsx test/diagnostics/war-ai-cost-calibration-report.ts`.
Raw and paired descriptive results are in
`diagnostics/war-ai-cost-calibration-{pilot,summary}.json.gz`.
