import type { WorldState } from "../world-state";
import type { WarState } from "../war-state";
import type { WarNegotiation } from "../war-negotiations";
import { assessPeaceOffer } from "../war-negotiations";
import { hasConferenceWar } from "../peace-conference";
import { reciprocalRecognitionTerms } from "./peace-recognition";
import { readPeaceAssessmentFact, type PeaceAssessmentContext } from "../peace-assessment-context";
import { getSeparatePeaceIssue } from "../separate-peace";
import { getWarDeclarationMode } from "../simulation-settings";
import { hasMinimumPeaceAge } from "../peace-maturity";

/** Route eligibility only; timing and willingness are evaluated separately. */
export function canNegotiateCampaignBilateralPeace(world: WorldState, war: WarState): boolean {
  return getWarDeclarationMode(world) === "diplomacy" && !war.isTest && !hasConferenceWar(world, war) &&
    !getSeparatePeaceIssue(world, war.nationAId, war.nationBId);
}

/** Read an existing, mature offer. A favorable hypothetical proposal is not an
 * agreement either government has published or is presently willing to accept. */
export function hasReadyCampaignSettlement(world: WorldState, war: WarState, negotiation: WarNegotiation | undefined, context?: PeaceAssessmentContext): boolean {
  return readPeaceAssessmentFact(context?.settlementReady, war, () => inspectPublishedOffers(world, war, negotiation, context));
}

function inspectPublishedOffers(world: WorldState, war: WarState, negotiation: WarNegotiation | undefined, context?: PeaceAssessmentContext): boolean {
  if (!negotiation || !hasMinimumPeaceAge(world.time.fastTick, war.startedAtFastTick) ||
    !canNegotiateCampaignBilateralPeace(world, war) ||
    !negotiation.automatic.get(negotiation.a) || !negotiation.automatic.get(negotiation.b)) return false;
  for (const [proposer, recipient] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
    const offer = negotiation.offers.get(proposer);
    if (!offer || world.time.slowTick - offer.revisedAtSlowTick < 10) continue;
    const terms = offer.terms;
    // Subject and scheduled-resource terms are directional. Their reciprocal
    // assessment is not a simple swap; keep executing until actual conclusion.
    if (terms.puppetTarget || terms.partition || terms.localSubject || terms.resourceReparation) continue;
    if (assessPeaceOffer(world, recipient, proposer, terms, context).accepts &&
      assessPeaceOffer(world, proposer, recipient, reciprocalRecognitionTerms(terms), context).accepts) return true;
  }
  return false;
}
