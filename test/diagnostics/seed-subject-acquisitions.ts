import { getPeaceBorderIssue } from "../../src/sim/peace-borders";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { getMesoById, getOwnerByMesoId } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";

/** Give distinct overlords ordinary, legal cessions bordering their existing subject. */
export function seedSubjectAcquisitions(world: WorldState, limit: number): number {
  const regions = getMesoById(world);
  const paired = new Set(world.nations.flatMap(({ id, subjectGovernment }) =>
    subjectGovernment ? [id, subjectGovernment.overlordId] : []));
  const capitals = new Set(world.nations.map(({ capitalMesoId }) => capitalMesoId));
  let seeded = 0;
  for (const subject of world.nations) {
    const overlord = subject.subjectGovernment?.overlordId;
    if (!overlord || seeded >= limit) continue;
    const owners = getOwnerByMesoId(world);
    for (const region of regions.values()) {
      const owner = owners.get(region.id);
      if (!owner || paired.has(owner) || capitals.has(region.id)) continue;
      if (!region.neighbors.some(({ id }) => owners.get(id) === overlord) ||
        !region.neighbors.some(({ id }) => owners.get(id) === subject.id)) continue;
      const leg = { from: owner, to: overlord, regionIds: [region.id] };
      if (getPeaceBorderIssue(world, [leg]) || !transferTerritories(world, [leg])) continue;
      seeded++;
      break;
    }
  }
  return seeded;
}
