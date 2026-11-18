# R2.23: feasibility of relief for an empty capital

R2.21 showed the local value of keeping an existing garrison. R2.22 showed
the limits of choosing by war role. In Stalemate 790 the role control lost
the original capital with fuel-starved unit-48 unable to fight. Nearby
positive-strength forces had competing frontline duties. It remains unclear
whether a different assignment could have delivered effective relief before
first hostile contact while maintaining the defenses it displaced.

## Preregistered feasibility audit

Use the unchanged canonical engine (simulation tree at `29fa088`). Observe
Stalemate 780/790/792 in development, plus four diagnostic seeds
1022748319780–1022748319783 in each of Matched, Stalemate and Reorganization.
Replay R2.22 Stalemate 790 as a mechanism comparison. Run the established
full-system normal-war fixtures (640×360 quick, 10,000 ticks). Audit each
opening defender at the end of normal slow decisions. Maintain opening-war
and start/end provenance, and verify the development replays against their
matrices.

An opening capital must still be controlled by its original owner, under
an existing threat assessment, and contain no positive-strength friendly
land unit. Count eligible same-nation mobile relief units above the existing
reorganization readiness floors, excluding special missions. Find the
shortest route through currently controlled land without hostile units.
Estimate travel using existing per-region movement speed and a fresh start.
For each candidate measure strength left at its source and assigned post.
A release must leave those positions above the existing coverage or supply
defense floor. Only physically present troops committed to stay at the post
count toward the remaining strength. Record legal routes and the coverage
test independently. Never use the subsequently observed contact deadline
to choose the candidate. Use the deadline afterward to measure whether any
observed route could have arrived before first hostile land contact or first
loss, whichever occurred earlier. Report contact-free openings separately
from met deadlines.

An observed opportunity is necessary for a relief-order intervention. If
the audit finds no eligible pre-contact release in the selected canonical
capital losses, reject extraction under the existing defense floor and
inspect the separate route, readiness and competing-assignment failure modes.
If any loss has such an opportunity, first test the observed mechanism in
that bounded case with a paired diagnostic before proposing a production
change. A static route or nominal arrival is insufficient evidence for
adoption. All final evaluation seeds remain untouched.

## Feasibility result and one-order counterfactual

The canonical audit covers 15 openings. Of 10 with observed first contact
or loss, five exposed an empty threatened capital at a slow decision.
Only development Stalemate 790 had a route that passed the existing post
floors and could reach the capital before contact. Among the selected
canonical defeats, 780 had 62 and 792 had 90 ready, routed unit/decision
pairs that could arrive in time on a static map. All failed the post
release gate. In 790, seven such pairs met the floor. At the first
opportunity (tick 190), unit-53 had a two-edge route through meso-68
and a 32-tick estimate. In meso-99 the committed forces staying behind
had strength 1352.20 against a floor of 1335.35. The first contact was
at 270 and first loss at 302. The R2.22 replay produced the same feasibility
observations for 790 before first contact. Three additional release options
in two diagnostic Reorganization openings had no observed contact deadline.

The four development replays match the frozen matrices' full war outcomes
and recorded non-CPU end states. The [canonical audit](../diagnostics/war-ai-r2-23-capital-relief-canonical.json.gz)
and [role-control replay](../diagnostics/war-ai-r2-23-capital-relief-r222.json.gz)
record the full denominators and input fingerprints.

For a bounded mechanism test, replay the canonical 790 opening twice
and retarget only unit-53 starting after tick 190 in the intervention arm.
Use its existing frontline movement, normally validated route and speed,
with no weapons, manpower, fuel or changes to enemy orders. Keep the
alternative destination while the original capital is threatened and the
unit remains effective and eligible for an ordinary frontline assignment.
Stop the override when a competing mission takes the unit, the capital
is lost, the threat ends or the war ends. The counterfactual must match
the unmodified trace through the observation at 190. Compare actual arrival,
hostile contact and first loss, defenders staying at meso-99, and both
opening roles' legal outcomes. Do not extrapolate from the selected
counterfactual or promote a candidate to the general matrix from a route
estimate alone.
