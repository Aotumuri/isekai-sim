import type { WorldState } from "../world-state";
import type { WarState } from "../war-state";
import type { WarNegotiation } from "../war-negotiations";
import { assessPeaceOffer } from "../war-negotiations";
import { hasConferenceWar } from "../peace-conference";
import { reciprocalRecognitionTerms } from "./peace-recognition";

/** Read an existing, mature offer. A favorable hypothetical proposal is not an
 * agreement either government has published or is presently willing to accept. */
export function hasReadyCampaignSettlement(world: WorldState, war: WarState, negotiation: WarNegotiation | undefined): boolean {
  if (!negotiation || hasConferenceWar(world, war) ||
    !negotiation.automatic.get(negotiation.a) || !negotiation.automatic.get(negotiation.b)) return false;
  for (const [proposer, recipient] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
    const offer = negotiation.offers.get(proposer);
    if (!offer || world.time.slowTick - offer.revisedAtSlowTick < 10) continue;
    const terms = offer.terms;
    // Subject and scheduled-resource terms are directional. Their reciprocal
    // assessment is not a simple swap; keep executing until actual conclusion.
    if (terms.puppetTarget || terms.partition || terms.localSubject || terms.resourceReparation) continue;
    if (assessPeaceOffer(world, recipient, proposer, terms).accepts &&
      assessPeaceOffer(world, proposer, recipient, reciprocalRecognitionTerms(terms)).accepts) return true;
  }
  return false;
}
