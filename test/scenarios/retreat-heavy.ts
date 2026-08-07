import { createUnitForType } from "../../src/sim/create-units";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateNationFrontAllocations } from "../../src/sim/nation-front-allocations";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { createUnitId, type UnitState } from "../../src/sim/unit";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { buildOwnerByMesoId, ensureLandUnitCount, startAdjacentWars } from "./scenario-utils";
import type { ScenarioSetup } from "./types";

export const setupRetreatHeavy: ScenarioSetup = (world, options) => {
  if (startAdjacentWars(world, 1) !== 1) {
    throw new Error("retreat-heavy requires an adjacent war");
  }
  const war = world.wars[0];
  if (!war) {
    throw new Error("retreat-heavy war was not created");
  }
  ensureLandUnitCount(world, options.quick ? 80 : 160);
  const border = findBorderPair(world, war.nationAId, war.nationBId);
  if (!border) {
    throw new Error("retreat-heavy could not find its land border");
  }
  const [regionA, regionB] = border;
  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    if (unit.nationId === war.nationAId) resetUnitAt(unit, regionA);
    if (unit.nationId === war.nationBId) resetUnitAt(unit, regionB);
  }
  const extraAttackers = options.quick ? 30 : 60;
  for (let index = 0; index < extraAttackers; index += 1) {
    const unit = createUnitForType(
      createUnitId(world.unitIdCounter),
      war.nationAId,
      regionA,
      index % 5 === 0 ? "Tank" : "Infantry",
    );
    world.unitIdCounter += 1;
    world.units.push(unit);
  }
  updateLandFronts(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
};

function findBorderPair(
  world: WorldState,
  nationAId: NationId,
  nationBId: NationId,
): [MesoRegionId, MesoRegionId] | null {
  const ownerByMesoId = buildOwnerByMesoId(world);
  for (const meso of world.mesoRegions) {
    if (meso.type === "sea" || ownerByMesoId.get(meso.id) !== nationAId) continue;
    for (const neighbor of meso.neighbors) {
      if (ownerByMesoId.get(neighbor.id) === nationBId) {
        return [meso.id, neighbor.id];
      }
    }
  }
  return null;
}

function resetUnitAt(
  unit: UnitState,
  regionId: MesoRegionId,
): void {
  unit.regionId = regionId;
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}
