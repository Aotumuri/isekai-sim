# Common government outcomes (prospective measurement supplement)

The original neutral objective proxy is retained unchanged. Its defender goal
is all opening homeland districts, and its survival flag means territorial
activity. A puppet government can retain every district. Neither measure alone
demonstrates that an independent defender preserved sovereignty. A regression
reproduces this distinction without altering either old metric.

Before any adoption claim, supplement every reference and candidate with the
same read-only opening-government observer. Snapshot the opening relationship;
freeze status, capital legal ownership and relationship preservation at the
opening war's observed end. Report independent, subject, exiled and eliminated
states separately. A dependent opening government may keep its original
relationship or become independent; a new master fails preservation. Also
record whether the opponent becomes the observer nation's subject, without
calling every such outcome successful fulfillment of a limited territorial goal.

Separately snapshot the opening nations' government status at episode end, so
early peace followed by later subjection/extinction is not hidden. Preserve
censoring of unfinished opening wars; do not count observation-time survival
as a resolved political success. Record real opening-war weapon transfers and
political settlement types alongside legal territorial value and the existing
independent whole-episode force/spending observations. Opposing roles remain
separate; no shared utility sum or retrospective success definition.

Start with the same three single-war development families and all 20 seeds,
Legacy-equivalent, R1 and frozen R2.15, followed by policy source controls as
needed. Cost audits now save rows atomically and reject mismatched engine,
harness, observer, runtime or conditions on resume. Verify outcome/end-summary
parity against observer-free matrices, and test actual government transitions
and terminal freezing. These additional safety/interpretation metrics cannot
waive the original adoption gates or turn the already rejected R2.14 into an
adopted candidate. The reserved final seeds remain untouched.
# Completed development observation (2026-11-13)

The five 60-case audits completed. All 300 replays exactly reproduce reference
non-CPU end summaries and full war outcomes; opening world fingerprints and
government/war end times agree. `war-ai-r2-16-validation.json.gz` records these
checks. `war-ai-government-development-report.json.gz` contains role-separated
distributions and paired seed-bootstrap intervals against Legacy. Reproduce:

```sh
node --import tsx test/diagnostics/war-ai-government-report.ts diagnostics/war-ai-government-{legacy,r1,r2-control,r2-selection,r2-natural}-development.json.gz
```

All opening wars resolved within the horizon. Defender government preservation
at opening-war end, in matched/stalemate/reorganization order, is Legacy
55/55/70%, R1 70/75/70%, control 80/55/60%, selection 65/65/65%, natural
70/55/65%. Selection's matched territorial survival is 70%, but government
preservation is 65%: survival alone hides the imposed new overlord in one case.
The original homeland and survival gates remain unchanged.

Two opening opponents became subjects and later ceased to belong to that
overlord: Legacy reorganization seed 822748319784 (nation-2 over nation-3),
and selection matched seed 822748319793 (nation-0 over nation-1). Both subject
nations are eliminated at episode end. These are selected causal-trace cases,
not evidence that all puppet losses reflect neglect, nor population estimates
of puppet maintenance: later wars and newly created local subjects are outside
the opening-government cohort.

Read-only lifecycle replays now distinguish these cases, with exact reference
non-CPU end summaries and full war outcomes. Legacy's nation-3 is peacefully
integrated into nation-2 at tick 6800 (event and territory/unit transfer agree).
It is **not** a maintenance failure. The report therefore names the generic
metric `subjectRelationshipEndedAfterResolvedOpeningRate`, not subject loss.

In selection seed 793, nation-0 establishes nation-1 as subject at tick 410.
Nation-0 fights nation-2 at 1810 and signs bilateral peace at 2210, including
territory and weapons. Their negotiated truce lasts until slow tick 521.
Nation-2 attacks nation-1 at fast tick 3210 (slow 321), after the separate
subject/enemy truce expired. Nation-0 does not join before nation-1 falls at
3282. The parent/enemy truce is still active throughout this interval.
`startDiplomaticWar` rejects diplomatically protected pairs even for defensive
alliance calls. This is a verified **non-participation under the existing truce
rule**, not evidence of ineffective action after participation or low priority
despite legal freedom to intervene. Nation-0 remains active and has 76 land
units at the attack snapshot, but unit count alone does not prove timely
deployability. No treaty rule is changed.

The same case also contains an earlier attack on the subject at tick 1210;
the parent was already at war with that enemy and both wars end at 1260.
Thus a missing new intervention event alone would misclassify participation.
Raw traces: `war-ai-subject-legacy-784.json.gz` and
`war-ai-subject-selection-793.json.gz`; replay with
`test/diagnostics/war-ai-subject-trace.ts --engine-root PATH` and the metadata's
seed/scenario/parent/child/campaign settings. Remaining questions are whether
peace valuation anticipates mismatched protection windows, how threatened
subjects enter the national portfolio, and what legal non-war support was
possible. These require separate evaluation before behavior changes.

The same trace separates material resources from eligible aid. At creation
(410), the parent/subject have 20/5 land units and 57.6/98.9 weapons; the
subject already has only two macro regions at episode start and creation.
At 2210 weapons are 151.2/0.5, and at attack (3210) 2697.2/12.5, with 76/10
land units. These observations do not establish timely military deployability
or intrinsic subject viability. No parent/subject arms-aid event occurs;
trade includes the parent buying eight weapons from the subject earlier and
later selling food for cash.

The parent character's cooperation is 0.3. Existing `updateArmsAid` skips
automatic donors below 0.5 before evaluating recipients, independently of
national maintenance benefits. At the later attack the observed parent/child
opinion is 9.74, trust 68.4, with trade/truce but no alliance, no shared faction
or current common enemy. `canSupportNation` does not treat the subject link
alone as friendly; its opinion/trust route requires both >=40. These are
separate existing eligibility/policy constraints, not evidence that the
parent considered a legal feasible shipment and ranked it too low. Delivery
route, timing, production response and other legal support remain to be
evaluated. Do not change shared diplomatic/aid permissions as an unreviewed
fix; assess whether the AI anticipates such limits when acquiring a subject.

Priority remains the measured survival regression and policy-model coverage.
These selected cases also allow testing whether settlement value and postwar
maintenance are disconnected. Record participation, feasible access, actual
deployment, competing commitments and subject viability before proposing any
behavior change. User-observed seed and experimental setting are unknown;
both Legacy and experimental paths remain in scope.
