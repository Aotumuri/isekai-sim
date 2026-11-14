# Selected standing-offer revision counterfactual

Preregistered before intervention outcomes. R2.20 stalemate seed
822748319786 publishes nation-0's white peace at 310 and settles at 410,
losing its opening objective. Its campaign ranks peace above military options
(0 versus -0.209/-0.417), whereas its reciprocal diplomatic assessment rejects
white peace. Historical cost is below its 1.4 tolerance; do not blame a hard
casualty cap. Future loss-rate projection, narrow political benefit and the
two evaluation scales remain possible causes, not established defects.

Use frozen uninstrumented R2.20 `3aa0ba7`, unchanged seed/settings/10,000 ticks.
Run an untreated replay and one explicit diagnostic intervention: immediately
before the slow pass at fast tick 310, temporarily advance only nation-0's
`lastRevisionSlowTick` in this bilateral negotiation. This prevents that one
automatic revision. Restore the original timer immediately after the pass.
Keep automatic acceptance, existing published terms, other nations, combat,
RNG and all legal rules untouched. Do not retract a binding offer or force
continued war/peace. Later normal AI revisions and acceptance remain possible.

Require the untreated control's common non-CPU end and complete war outcomes
to match the frozen matrix. Compare recorded pre-intervention checkpoints,
prove the timer was restored and old terms retained through the skipped pass,
and report actual subsequent offers/settlements. At opening-war end, compare
own attacker/defender legal gains, objective retention, survival, direct
casualties and elapsed ticks separately; record remaining whole-episode costs
without confusing them with this war. No intervention arm should reproduce
the original end by construction. This selected counterfactual estimates the
effect of one revision delay, not optimal future policy or a population effect.
No production policy is adopted from this case and final seeds stay unused.

## Observed result

The untreated replay matches the frozen matrix. Both arms have identical
recorded checkpoints at 309 (CPU measurements excluded). The intervention
temporarily changes timer 1 to 30 at 309, restores 1 at 310 and verifies the
old offer was retained. Both then settle nation-0's white peace, at 410 and
510 respectively. Neither arm retains the aggressor objective or gains legal
territory; both nations survive and the defender retains its home objective.

Opening-war direct casualties rise from 196.42 to 228.90 for the attacker and
181.97 to 221.45 for the defender. Thus this one-cycle delay yields additional
losses and no additional opening-war gains under the unchanged military AI.
It does **not** test a deliberate new offensive strategy, establish that the
original forecast is calibrated, or prove early peace is generally optimal.
The candidate's peace preference has an observable cost basis; high military
advantage alone was insufficient evidence that delaying peace would pay off.

The 10,000-tick episodes also diverge in later wars and national survival.
Those endogenous effects are separate from the opening-war marginal losses;
do not sum opposing interests or infer a general benefit from final country
counts. Raw branches and explicit validation are archived as
`war-ai-peace-revision-r2-20-{control,defer}-786.json.gz` and
`war-ai-peace-revision-r2-20-786-validation.json.gz`.
