# R2.24: separate relief admission from on-station release

Preregistered after the [R2.23 order probe](AI_R2_CAPITAL_RELIEF.md).
At Stalemate 790's first capital contact, the single relief unit was still
effective at its destination. Its organization fell just below the
admission floor and the existing probe canceled the order. The normal
frontline assignment diverted the unit immediately. Test whether keeping
the already arrived relief on station through initial damage preserves
an attainable opening objective.

Use the same canonical Stalemate 790 fixture and the identical unit,
190-tick decision, route and admission criteria. Change only the
post-arrival exit condition: keep an effective unit on station while it
has an ordinary frontline assignment, remains on the controlled threatened
capital, and no retreat, recovery, or other special mission supersedes it.
The transit admission criteria and all other release conditions remain
the same. This compares two diagnostic overrides of the same engine.
Trace orders, combat, legal territory, capital control, survival and
effects on the source position. Use the same horizon and require replay
parity through tick 329, immediately before the original release.

Advance only if contact and arrival occur as expected and the defender
retains its opening home objective or survives the opening war. A slower
loss alone would fail the targeted gate. A pass on this selected seed
would motivate a preregistered broader exposure check with the established
development seeds. The final evaluation partition is untouched.

## Result

The recorded samples match R2.23 through tick 329, and both arms share
the same decision-state hash. Arrival at 222 and first contact at 330
were identical. The on-station rule kept unit-53 at meso-72 through tick
385, and the next combat step removed it. The first loss of the original
capital was delayed four ticks (386 to 390), while elimination came 16
ticks earlier (406 to 390). Both runs lost the same six legal regions.
Defense casualties were 152.67 and 153.26 respectively. Meso-99 had no
positive defending strength by tick 380 in the hold arm. Its ownership
had not yet changed in the samples before elimination.

The targeted gate **failed**. The defeated government needed more than
timely arrival or a longer commitment of this unit. R2.23 found
legal, floor-preserving options in only one of the ten openings with
observed contact or loss, and the observed margin was small. These data
give no basis for enabling a general release or holding rule.

Reproduce with the R2.23 harness flags and `--order-probe hold`.
The [hold replay](../diagnostics/war-ai-r2-24-order-hold-790.json.gz)
retains the same source tree with a separate harness hash.
