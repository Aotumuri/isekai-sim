import type { NationId } from "../worldgen/nation";
import { getNationFaction } from "./factions";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";

export function getSeparatePeaceIssue(world: WorldState, a: NationId, b: NationId): string | null {
  for (const [nation, enemy] of [[a, b], [b, a]]) {
    const faction = getNationFaction(world, nation);
    if (faction?.charter.jointPeaceOnly && faction.memberIds.some((member) => member !== nation && findWar(world.wars, member, enemy))) {
      return `${faction.name} prohibits separate peace while its other members fight this opponent. Convene joint peace or leave the faction first.`;
    }
  }
  return null;
}
