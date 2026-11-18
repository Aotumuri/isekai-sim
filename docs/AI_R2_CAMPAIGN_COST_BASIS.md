# R2.25: false loss-rate pulses when concurrent war scope changes

Campaign cost is normalized by the largest opening manpower investment
across active wars. Slow-pass forecasting differentiates two successive
normalized fractions. If the largest investment leaves the active set,
the fraction may rise at unchanged unavailable manpower. That would
inject fictitious recent losses into alternatives and give excess weight to
immediate diplomatic or defensive choices. A rising denominator may mask
genuine losses, and the carried rate also changes its unit of measure.

Before changing production code, instrument canonical in the registered
60-case development population. Observe all active nations at every campaign
decision to expose later and concurrent wars. Record each denominator change,
old/new numerator and denominator, logged and rebased rates, the war scope,
and the campaign decision. Retain start and outcome provenance with the
fixed matrix and check exact common non-CPU end states and full war outcomes.

For isolated forward estimates, use the same current denominator to
calculate the previous and current cumulative loss fractions. Carry the
previous smoothed rate in the same units. Keep the cumulative loss tolerance,
30-second policy horizon and other rules unchanged. A forecast repair must
affect a real denominator transition. Prioritize the production candidate
only if the trace includes a meaningful change in a 30-second loss forecast
(at least 5 pp before or after clipping, reported separately), with a
controlled regression demonstrating the distinction between actual losses
and a denominator change. The case audit is descriptive. Judge any candidate
against the registered baselines under the original dynamic evaluation
protocol. Reserved final seeds are unused.

## Exposure gate

The three archives (`war-ai-r2-25-basis-*.json.gz`) cover 60 development
replays and 26,876 paired consecutive national decisions. All recorded
non-CPU end states and full war histories match the canonical matrix.
There are 38 changed denominators. Seventeen transitions move the
unclipped 30-second forecast by at least 5 pp, and 13 do so after clipping
(Matched 3, Stalemate 5, Reorganization 5). The decisions after the change
are descriptive and include existing policy commitments.

At Stalemate 788, nation-0's decision at tick 6200 shrank the denominator
from about 353,931 to 53,900 when two wars became one. The implied
unavailable manpower did not increase. The actual clipped forecast was
100%, versus roughly 0.004% after rebasing. The war campaign mode remained
seek-peace on that pass. This establishes a forecast error, with a
decision or outcome improvement still to be tested.

The candidate will change only the rate calculation by expressing both
successive fractions and the carryover in the current denominator. The
integrated regression will end a concurrent war at fixed cumulative
losses and check that the rate decays without a pulse, then record genuine
new losses. Freeze after the regression and full checks. Compare the
registered 60 cases against canonical, R1 and Legacy, with cost/government
replays if any outcomes change. Verify the correction in the reproduced
exposure and report paired opening-war outcomes and decision/trajectory
differences separately.
