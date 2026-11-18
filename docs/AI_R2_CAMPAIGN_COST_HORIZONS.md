# R2.26: factual cost horizons during offensive effort

The pre-existing [calibration pilot](AI_CAMPAIGN_COST_CALIBRATION.md)
has zero eligible 30-second limited-offensive windows. Test whether the
coverage failure is specific to that horizon or whether the archived data
also lack shorter stable offensive exposures. Use the same 12 canonical
cases and all the same origins. Reclassify at 5, 10, 15 and 30 seconds
with the original membership, denominator, military mode and priority
checks. Use every eligible origin. Report windows and distinct scenario/seed
cases, censor reasons, and equal-case mean forecast and realized costs by
opening role and observed military mode. Validate the original 30-second
results exactly. The remaining original cases and all final seeds stay
untouched.

A shorter factual window estimates costs during observed stable effort.
It leaves unresolved the cost of an unchosen alternative or a policy
that blocks a mode change or a settlement. No policy horizon or coefficient
will be selected for having the best fit here. For a future modeling
intervention, require positive realized loss in at least six independent
scenario/seed cases across at least two families at 15 seconds, the longest
new short horizon. This minimum looks for repeatable exposure to losses
at a horizon relevant to actual operations. Even with that coverage,
a fresh diagnostic partition would be needed to test an estimator.

## Result

All 30-second classifications, censor reasons and eligible costs match
the archived pilot. Repeated generation produces byte-identical output.

| Limited-offensive horizon | Eligible windows out of 60 | Cases with eligible positive loss | Case-mean predicted / observed loss fraction |
| --- | ---: | ---: | ---: |
| 5 seconds | 29 | 3 | 2.535% / 0.067% |
| 10 seconds | 16 | 2 | 4.901% / 0.020% |
| 15 seconds | 6 | 2 | 11.092% / 0.025% |
| 30 seconds | 0 | 0 | unavailable |

At 15 seconds, 54 origins encounter a military-mode change, 30 a
priority-opponent change, and 26 an opening-war end. Reasons can overlap.
The 15-second offensive comparisons cover two families and only two
independent cases. Defensive comparisons have different exposure:
for opening defenders using defend mode, the 15-second mean is 16.226%
forecast versus 29.311% observed across 12 cases. The overlapping
windows are correlated and estimates condition on continued effort.
The offensive modeling gate **fails**. There is no basis in this sample
for an offensive coefficient or changing the planning horizon.
Follow-on model work needs either sustained, independently observed
offensive cases or a forecast that models switching and settlement as
competing events.

Reproduce with `node --import tsx test/diagnostics/war-ai-cost-horizon-report.ts`.
The [report](../diagnostics/war-ai-r2-26-cost-horizons.json.gz) retains
case means and censor reasons for each role, mode and horizon.
