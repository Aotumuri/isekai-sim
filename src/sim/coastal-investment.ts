import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import { constructPort, PORT_CONSTRUCTION_COST } from "./port-construction";
import { buildWarAdjacency } from "./war-state";
import { getMesoById, getOwnerByMesoId, getPortTargetsByNation } from "./world-cache";
import type { WorldState } from "./world-state";

/** Peaceful commercial nations can invest a surplus in their first port. */
export function updateCoastalInvestment(world: WorldState): void {
  if (!world.settings?.diplomacyEnabled || !world.settings.tradeEnabled ||
    world.time.slowTick % 60 !== 0) return;
  const wars = buildWarAdjacency(world.wars);
  const ports = getPortTargetsByNation(world);
  const owners = getOwnerByMesoId(world);
  const regions = getMesoById(world);
  const investors = new Set(world.nations.filter((nation) =>
    isNationActive(nation) && !wars.get(nation.id)?.size && !ports.get(nation.id)?.length &&
    nation.resources.steel >= PORT_CONSTRUCTION_COST.steel * 2 &&
    nation.resources.fuel >= PORT_CONSTRUCTION_COST.fuel * 2 &&
    getNationCharacter(world, nation.id).doctrine === "merchant").map((nation) => nation.id));
  if (!investors.size) return;

  const sites = world.mesoRegions.flatMap((region) => {
    const owner = owners.get(region.id);
    if (!owner || !investors.has(owner) || region.type === "sea" || region.building) return [];
    const seaAccess = region.neighbors.filter(({ id }) => regions.get(id)?.type === "sea").length;
    return seaAccess > 0 ? [{ id: region.id, owner, seaAccess }] : [];
  }).sort((a, b) => b.seaAccess - a.seaAccess || a.id.localeCompare(b.id));

  for (const site of sites) {
    if (investors.has(site.owner) && constructPort(world, site.owner, site.id)) investors.delete(site.owner);
  }
}
