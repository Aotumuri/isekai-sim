import { WORLD_BALANCE } from "../data/balance";
import { isNationActive } from "./nation-active";
import { getIdeologies } from "./nation-identity";
import { getNationalPolitics } from "./politics";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getWarCasualties, type WarState } from "./war-state";
import type { WorldState } from "./world-state";

export function recordWarAccountability(world: WorldState, war: WarState, aggressorSecuredGains: boolean): void {
  const responsibleParty = war.openingAggressorIdeologyId;
  if (!responsibleParty || aggressorSecuredGains || !hasPoliticalTurbulence(world)) return;
  const losses = getWarCasualties(war, war.aggressorId);
  const lostFormations = Math.floor(losses / WORLD_BALANCE.unit.types.Infantry.manpower);
  if (!lostFormations) return;
  const aggressor = world.nations.find(({ id }) => id === war.aggressorId);
  if (!aggressor || !isNationActive(aggressor)) return;
  const politics = getNationalPolitics(world, aggressor);
  const opposition = [...politics.support].filter(([id, share]) => id !== responsibleParty && share > 0 &&
    !(id === politics.suppression?.ideologyId && politics.suppression.until > world.time.slowTick))
    .sort(([idA, a], [idB, b]) => b - a || idA.localeCompare(idB))[0];
  const support = politics.support.get(responsibleParty) ?? 0;
  const points = Math.min(support, 8, politics.system === "democracy" ? lostFormations : Math.floor(lostFormations / 2));
  if (!opposition || points <= 0) return;
  const [alternative, share] = opposition;
  politics.support.set(responsibleParty, support - points);
  politics.support.set(alternative, share + points);
  const partyName = getIdeologies(world).find(({ id }) => id === responsibleParty)?.name ?? responsibleParty;
  recordSimulationEvent(world, { category: "politics", nationIds: [aggressor.id],
    message: `${partyName} lost ${points} points of support in ${aggressor.id} after an offensive war ended without territorial or political gains.` });
}
