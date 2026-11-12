# Policy causal follow-up after R2.16

R2.16 remains frozen and complete. This is a separate read-only investigation
on already observed development seeds; no final seeds or adoption gates change.
No new policy arm is added.

Trace stalemate seeds 822748319783, 792, 793, 794 in the original control,
selection and natural sources. Selection rescues defenders in the first three
and loses a previously surviving defender in 794; natural loses the three
rescues while retaining the 794 survival. These are selected contrasts, not an
unbiased estimate of quality. Replay the full 10,000 ticks and require exact
non-CPU end summaries and full war outcomes against the archived matrices.

Use the existing read-only nation/lifecycle tracer with the opening attacker
and defender as the two tracked nations (`--parent` and `--child` are tracer
labels, not an assertion that the pair is dependent). Compare both governments'
mode, military effort, forecast alternatives, front plans, force locations,
resource stocks and actual settlements before the first consequential
divergence. Do not infer causality from the losing side alone. Determine
whether a missing defensive/positional benefit, overestimated reachable force,
review timing or concentration timing explains the intervention, before
changing a model or adding exceptions. Any subsequent behavior change needs
its own preregistered experiment and safety checks.

Separately, the subject trace established a real truce protection gap without
changing diplomacy rules. Before modifying peace value, inspect whether
political settlement alternatives already price dependence, occupation,
subject viability and maintenance. Peaceful integration must remain distinct
from losing a subject to an enemy. Claims already provide some persistent
territorial interests; inspect their lifecycle before proposing a new national
goal store. These observations inform priority, not immediate patches.

## Trace findings and R2.17 preregistration

All 12 lifecycle/nation replays reproduce full war outcomes and non-CPU end
summaries (`war-ai-policy-causal-validation.json.gz`). In seeds 783 and 793,
the attacker's initial selection changes from scored defense to unscored
limited offense while the defender initially remains defensive. Natural
concentration removes those rescues. In 792 the attacker changes later, and
selection delays the defender's rapid depletion. In 794 selection instead
accelerates defender collapse to tick 108. These observations do not establish
an improved defensive model: both sides and focus timing were interventions.

Run a new role-specific source-control experiment, R2.17, with control source
`29fa088`, plus two variants of the archived selection patch:

1. Use the unscored selection/review/military-fallback branch **only for the
   formal aggressor** in each single active bilateral war.
2. Use that branch **only for the formal defender** in each single active war.

All other nations retain scored selection. Keep proactive concentration, all
forecast recording and scored actual peace willingness, review/material and
emergency guards, cost/recovery budgets, rules and direct-order protection.
Multiple-war nations keep scored control. This tests role-local responsibility;
formal aggressor is the existing war field, not moral responsibility (including
defensive-alliance declarations). These remain diagnostic variants, not fixes.

Use the same 20 already observed development seeds, matched/stalemate/
reorganization, full systems, normal wars, 640x360, 10,000 ticks. Freeze source,
archive patches/hashes, require matching starts and zero invalid cases, and
run targeted safety checks before matrices. Compare both new arms against the
original R2.16 control and both-sided selection, then Legacy/R1 if relevant.
Record both roles' goals, survival, legal gains, costs and censoring separately.
Use existing paired 95%/10,000-bootstrap reports; do not claim CPU gains from
concurrent runs. No coefficients, original R2.16 conditions, final seeds or
adoption gates change. A defender benefit caused by weakening the attacker is
not evidence that the defender's own decision rule improved.

## R2.17 development results

Both role controls completed 60/60 cases with zero failures and exactly matching
start summaries/settings. Patches, source trees, safety checks and runtime are
in `war-ai-r2-17-validation.json.gz`. Four paired reports compare control and
both-sided selection. No arm is a production change or an adopted improvement.

| Unscored role | Family | Attacker goal | Attacker survives | Defender homeland | Defender survives |
| --- | --- | ---: | ---: | ---: | ---: |
| Aggressor only | Matched | 35% | 100% | 60% | 70% |
| Defender only | Matched | 40% | 100% | 60% | 75% |
| Aggressor only | Stalemate | 35% | 90% | 50% | 65% |
| Defender only | Stalemate | 50% | 95% | 40% | 55% |
| Aggressor only | Reorganization | 60% | 95% | 30% | 65% |
| Defender only | Reorganization | 45% | 95% | 45% | 60% |

Against the scored control, aggressor-only changes stalemate defender survival
by +10 pp [-10, +30], attacker goal by -15 pp [-30, 0], and attacker survival
by -10 pp [-25, 0]. Defender-only changes stalemate defender survival by 0 pp
[0, 0]; matched defender survival changes -5 pp [-15, 0]. Reorganization
attacker goal changes +15 pp [-5, +35] under aggressor-only and 0 under
defender-only. These results support separating opponent weakening from own
defensive competence, with wide intervals on many contrasts. Do not choose
the source control based only on the opponent's survival.

Additional read-only focus traces for 783/794 retain exact reference end states
and full outcomes. Focus affects **operation size**, not just which front is
prioritized: `buildOperationCandidate` selects the existing 90% surplus fraction
whenever `isSchwerpunktOperation`, even when `isMajorOffensive` is false; normal
operations use 60%. In selection seed 794 the early focused operation has
initial strength 4554 versus control's 2728 and succeeds where control's first
operation depletes. In 783 both first operations cancel on changed posture,
with 3415 versus 2732 assigned strength and later divergent field outcomes.
The benefit is therefore conditional; this is not evidence that smaller forces
are always better or that early concentration should be removed. Raw expanded
traces are `war-ai-focus-*`, with `war-ai-focus-validation.json.gz`.

Both 60-case cost/government replays also completed with exact non-CPU end
summaries and full war outcomes. `war-ai-government-r2-17-report.json.gz`
contains paired costs, without adding attacker and defender interests.
Aggressor-only reduces stalemate attacker production manpower by 50,421
[-104,044, -2,756], alongside worse attacker goal/survival results; this is not
a cost-efficiency victory. Its defender whole-episode unavailable manpower
changes +11,359 [-4,751, +31,487]. Defender-only has no resolved stalemate
government-preservation gain and no clear field-loss reduction. These controls
do not meet adoption requirements; production remains unchanged.

Replay validation is now directly reproducible:

```sh
node --import tsx test/diagnostics/war-ai-replay-validation.ts diagnostics/war-ai-r2-17-aggressor-development.json.gz diagnostics/war-ai-government-r2-17-aggressor-development.json.gz
```

Use `--subset` explicitly for individual selected traces. The validator rejects
duplicate cases and changed end states; it claims only common recorded fields,
not equality of all hidden state.
