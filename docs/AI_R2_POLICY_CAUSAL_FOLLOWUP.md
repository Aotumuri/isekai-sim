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
