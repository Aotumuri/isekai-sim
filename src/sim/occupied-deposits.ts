import { isStrategicResource } from "../data/strategic-resources";
import type { MesoRegionId } from "../worldgen/meso-region";
import { isNationRegionSupplied } from "./supply-assessment";
import { findWar } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

/** A supplied garrison can keep a captured strategic deposit running at half output. */
export function getOperatingOccupiedDeposits(world: WorldState): Set<MesoRegionId> {
  const operators = new Set<MesoRegionId>();
  if (!world.occupation.mesoById.size || !world.wars.length) return operators;
  const regions = getMesoById(world), owners = getOwnerByMesoId(world);
  for (const unit of world.units) {
    const { regionId, nationId } = unit;
    if (unit.domain !== "land" || unit.manpower <= 0 || unit.moveToId || operators.has(regionId) ||
      world.occupation.mesoById.get(regionId) !== nationId || !isStrategicResource(regions.get(regionId)?.resource)) continue;
    const owner = owners.get(regionId);
    if (!owner || owner === nationId || !findWar(world.wars, owner, nationId)) continue;
    if (isNationRegionSupplied(world, nationId, regionId)) operators.add(regionId);
  }
  return operators;
}
