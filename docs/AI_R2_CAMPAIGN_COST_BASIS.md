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

## Frozen forecast candidate

Isolated `de5fbf459a910b3930f98ab742d5e174259d1362`, source tree
`cd761ef200c300278eb1a935c621b2042e643049`, applies to `82a7ee3` via
[the archived patch](../diagnostics/war-ai-r2-25-cost-basis.patch).
Patch SHA-256 is
`f369ba8237f9d7fe388c47cd63e62a4bdb4122c74d636aca2e44e9bcb44da598`.
The integrated concurrent-war regression fails the canonical forecast.
The candidate passes 729 regressions, typecheck, build and quick benchmark.

The isolated candidate reproduces both denominator transitions of
Stalemate 788, with zero physical loss on each. At tick 6200 its clipped
30-second projection is 0.00369%. The canonical value is 100%. The
[replay](../diagnostics/war-ai-r2-25-basis-rebased-788.json.gz) records the
actual candidate observation. The established 60-case development
comparison determines whether the accounting correction influences quality.

## Development result

The 60 cost/government replays matched the candidate matrix's recorded
non-CPU end states and full war histories. The matrix retained every
recorded opening-war outcome exactly,
including timings and losses. Fixed opening attacker objective rates
remain 35/50/45% and defender survival rates remain 80/55/60% across the
three families. Stalemate defender survival is 20 pp below R1
([−40, −5], paired 95% interval). The forecast correction does not resolve
the recurring opening survival regression.

Two rows changed later-war history. In Matched 791, the war opened at
5710 ended at 6010 instead of 6910. Both sides retained the same legal
territorial results (+5/−5), and recorded casualties fell from 1293.09
to 792.16 for nation-0 and 880.47 to 441.10 for nation-2. Other later
wars in that row also shifted. In Reorganization 784, nation-2 retained
the same outcome against nation-0 and won 21 ticks sooner, with recorded
losses of 750.73 versus 786.35. Those are selected realized effects with
later geopolitical divergence. Across the paired families, intervals for
mean active-war duration include zero. For the opening Matched aggressors,
whole-episode production-recorded fuel is 2.4% lower on average and
unavailable field manpower is 5.1% lower against canonical. Opening-war
government preservation is identical in every family. The paired reports
include legal outcomes, casualties and costs. Median process CPU for the
three families is 7.6–9.6% lower in these runs. This comparison does not
isolate same-state CPU cost.

Decision traces show where changes first appeared in the selected windows.
In Reorganization 784, nation-2 switched military effort to limited
offense at 2050 in the candidate, while the canonical plan remained
defensive. At the canonical denominator contraction (2110), its cumulative
casualty fraction was still below hard tolerance (1.005 vs 1.400).
In Matched 791, nation-0's pattern first diverged at 5270, after the
rebasing exposure on scope change at 5230. It adopted defense while the
canonical campaign retained limited offense. These records support a
forecast-ranking mechanism and give no direct evidence for changing the
cumulative casualty budget.

R2.25 is **not adopted** under the strategic quality protocol. It
corrects a reproducible accounting error and resolves two late-episode
trajectories differently. The primary opening results are identical in
all 60 cases and the broader improvements remain unestablished. The
patch and two-arm late decision traces are retained. The final evaluation
partition remains unused.

The [validation record](../diagnostics/war-ai-r2-25-validation.json.gz)
links all replays. The full inputs and bootstrap reports use the
established matrix and government scripts.
