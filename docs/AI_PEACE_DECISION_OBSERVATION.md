# Prospective exact peace-decision observation

This is a read-only follow-up to the user's observations, alongside the
unchanged R2.18 comparison. No diplomatic rule or decision is changed.

Instrument an isolated engine checkout with a zero-duration diagnostic signal
inside `acceptPeaceOffer`, after validation and before transfers or peace.
An external observer can then record the actual accepted offer, published age,
recipient acceptance, ordinary reciprocal willingness, current alternatives,
political goals, war advantage, urgency, stock/force context, legal puppet
alternative and parent/subject/enemy truce windows. Require exact common
non-CPU end summaries and full war outcomes against observer-free references.
Archive the hook patch and harness hash; do not insert it in production.

Do not equate a legal puppet alternative with a better strategy. Its recipient
score is not an expected net benefit to the prospective overlord. Mark missing
political reciprocal values as unsupported rather than zero. A truce-window
gap is a legal constraint under a hypothetical future attack, not a prediction
of that attack. Actual subject loss still requires the lifecycle evidence.

First selected contrasts use already observed development seeds: stalemate
782/784 and reorganization 780 in canonical source `29fa088`, plus selection
matched 793's later parent/enemy peace at 2210. Legacy/R1 observations remain
in scope because the user's setting is unknown; follow with matched 781 and
stalemate 780 in their frozen source. These are selected cases, not a new
quality population or adoption gate. Keep full 10,000-tick parity references.

## First exact observation

Selection matched seed 822748319793 was replayed for 10,000 ticks using an
isolated one-line instrumentation hook. All three observed pre-transfer
decisions match actual subsequent settlements, and the complete war outcomes
and non-CPU end summary match the observer-free R2.16 selection reference.
The hook, trace and validation are archived as `war-ai-peace-decision-*`.
The hook applies independently to public `29fa088`; selection first applies
its archived selection patch. Neither production nor R2.18 engines change.

At tick 2210, nation-0's published offer to nation-2 is ten slow ticks old.
It demands seven districts and 60 weapons. Recipient acceptance score is
+59.365. The ordinary reciprocal assessment of those same receipts for the
proposer is -44.610 (expects a better outcome by continuing). The proposer has
advantage +0.809 and domestic urgency 0.013, but its campaign is seeking peace.
A puppet alternative with 60 weapons is currently legal and its recipient
accepts with score +52.263. This establishes an actual case worth investigating;
it does not prove puppetization has higher net value after maintenance, or
that the already published offer should cease to bind.

At the same instant the existing subject nation-1 has a truce with nation-2
until slow tick 291; the parent's accepted truce lasts until 521, a conditional
230-tick protection gap. The earlier lifecycle trace independently records
nation-2 attacking the subject at fast tick 3210 and defeating it at 3282 while
the parent remains under truce. This is the known non-participation case, not
an inference from an aggregate intervention counter.

Next inspect the offer's publication/revision context, the difference between
campaign exit pressure and proposer willingness, and legal non-war support.
Preserve the existing binding-offer and truce rules. Evaluate future changes
to the AI's choice of published terms separately; do not make the AI always
choose puppetization when it is legally available.

## Publication extension

The observer now distinguishes `publication` from `acceptance`, and an isolated
hook also signals after both opening offers are constructed and immediately
after an automatic revised offer is installed. The root harness typechecks.
The hook patch, including type-only metric-name declarations, applies to both original frozen parents and is
archived as `war-ai-peace-publication-hook.patch`. Frozen observation sources:

- `/private/tmp/isekai-peace-decision-29fa088`, HEAD `fa2da33`.
- `/private/tmp/isekai-peace-decision-selection`, HEAD `4846dd9`.

Both observed engines now typecheck. The first check exposed the restricted
metric-name type; diagnostic names were declared only in these isolated
checkouts. The selection 793 replay records 30 publications and three
acceptances, preserving full reference war outcomes and non-CPU end summaries.
Every acceptance matches an actual settlement. It is saved separately as
`war-ai-peace-publication-selection-793.json.gz`.

At publication (2110), the proposer's reciprocal assessment was already
negative, -40.630, while the recipient would accept at +14.775. Thus this case
is **not explained solely by an originally satisfactory offer becoming stale**.
Puppetization was then illegal (occupation/city requirement), becoming legal
by acceptance at 2210. The existing offer is binding; do not add a unilateral
last-minute veto. Inspect how the AI chooses/revises its standing terms and
how political upgrade opportunities and maintenance constraints enter its
forecast. The internal campaign and diplomatic acceptance models also disagree
about continuation, which needs separate calibration.

The three canonical selected replays completed. At their opening-war peace,
proposer reciprocal scores are -27.604 (stalemate 782), -15.185 (stalemate 784),
and -43.826 (reorganization 780), while recipients accept. In all three the
puppet occupation/city requirement is **not met**, despite military advantage
reaching +1.0 in reorganization 780. These are selected contrasts, not a rate
of premature peace or proof of feasible puppet superiority. Parity validation
is recorded separately; Legacy/R1 scope remains pending.

The same observation signals are prepared and typechecked in a separate
Legacy/R1 checkout `/private/tmp/isekai-peace-decision-r1`, HEAD `ce1d6dc`.
`war-ai-peace-publication-r1-hook.patch` applies to public `e6245a1`; the older
metric schema is preserved with only the two diagnostic name declarations.
Run matched 781 and stalemate 780 with campaign off/on after current pipelines
free capacity, and validate each against the original full matrix. No Legacy
or R1 observation replay has yet been claimed complete.

## Completed Legacy/R1 selected scope

All four prepared replays are now complete: matched 781 and stalemate 780,
campaign off/on. Each reproduces its matching original matrix's non-CPU end
summary and full war outcomes; every sampled acceptance matches a settlement.
The observer source metadata is retained and its hook-only difference from
`e6245a1` is explicit in `war-ai-peace-publication-legacy-r1-validation.json.gz`.

In stalemate 780, both engines settle at 410 with the original proposer still
preferring continuation under its reciprocal assessment (Legacy -71.56,
R1 -62.98). The recipient accepts at +3.13/+5.16. Puppetization is legal then
but the recipient rejects that alternative (-10.20/-6.58). In matched 781's
nation-0/nation-2 settlement at 410, proposer values are -53.21/-48.60 and
recipient values +13.72/+3.47; a puppet alternative is legal and accepted by
the recipient (+13.29/+16.17). These are selected observations, not an overall
premature-peace rate or proof of net political benefit. The disagreement
between standing-offer publication and proposer continuation assessment also
exists in Legacy; it is not unique to the experimental campaign controller.
No binding-offer, acceptance or puppet/truce rule has been changed.

## R2.20's changed stalemate 786

The paired publication replays preserve their own matrix end summaries and
full war outcomes. Only the fuel candidate publishes nation-0's white peace
to nation-1 at 310; that proposal is actually accepted at 410. Its recipient
scores +20.63 at publication and +22.26 at acceptance, while proposer reciprocal
scores are -72.64/-70.05. A puppet alternative is illegal at publication.

The campaign's reason is not simply military weakness or an exceeded hard
budget. At publication its latest assessment has strength ratio 2.937,
casualty fraction 0.5435 below tolerance 1.4, food runway 8,900 seconds,
no capital emergency and no replacement constraint. Its alternatives prefer
peace (0) over defense (-0.209) and attack (-0.417); projected attack resource
cost is 0.676, with observed loss rate 0.02186. Its territorial-concession
goal is unmet. Thus the campaign's projected future cost/value comparison
explains an exit preference, while the diplomatic willingness scale disagrees.
This does not establish either model as correct. The next selected
[revision-delay counterfactual](AI_PEACE_REVISION_COUNTERFACTUAL.md) measures
actual continuation consequences without replacing legal rules or assuming
that a high force ratio requires continued war.
