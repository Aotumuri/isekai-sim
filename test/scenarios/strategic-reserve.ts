import { updateCapitalDefense } from "../../src/sim/capital-defense";
import { createUnitForType } from "../../src/sim/create-units";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateNationFrontAllocations } from "../../src/sim/nation-front-allocations";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { updateRetreatPlans } from "../../src/sim/retreat-plans";
import { updateStrategicReserves } from "../../src/sim/strategic-reserves";
import { createUnitId } from "../../src/sim/unit";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { buildOwnerByMesoId, startAdjacentWars } from "./scenario-utils";
import type { ScenarioSetup } from "./types";

export const setupStrategicReserve: ScenarioSetup = (world, options) => {
  if (startAdjacentWars(world, 1) !== 1) {
    throw new Error("strategic-reserve requires an adjacent war");
  }
  const war = world.wars[0];
  if (!war) throw new Error("strategic-reserve war was not created");
  const border = findBorderPair(world, war.nationAId, war.nationBId);
  const defender = world.nations.find((nation) => nation.id === war.nationBId);
  if (!border || !defender) {
    throw new Error("strategic-reserve border or defender is missing");
  }
  const [attackerFrontId, defenderFrontId] = border;
  world.units = world.units.filter(
    (unit) =>
      unit.nationId !== war.nationAId && unit.nationId !== war.nationBId,
  );
  addForce(
    world,
    war.nationAId,
    attackerFrontId,
    options.quick ? 10 : 20,
  );
  addForce(
    world,
    defender.id,
    defenderFrontId,
    options.quick ? 13 : 26,
  );
  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  updateStrategicReserves(world);
  updateNationFrontAllocations(world);

  // The reserve exists before the balance worsens, so the scenario observes a
  // real pre-positioned response rather than emergency-time force creation.
  addForce(
    world,
    war.nationAId,
    attackerFrontId,
    options.quick ? 7 : 14,
  );
  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateRetreatPlans(world);
  updateStrategicReserves(world);
  updateNationFrontAllocations(world);
};

function addForce(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    world.units.push(
      createUnitForType(
        createUnitId(world.unitIdCounter),
        nationId,
        regionId,
        index % 6 === 0 ? "Tank" : "Infantry",
      ),
    );
    world.unitIdCounter += 1;
  }
}

function findBorderPair(
  world: WorldState,
  attackerId: NationId,
  defenderId: NationId,
): [MesoRegionId, MesoRegionId] | null {
  const ownerByMesoId = buildOwnerByMesoId(world);
  for (const region of world.mesoRegions) {
    if (region.type === "sea" || ownerByMesoId.get(region.id) !== attackerId) {
      continue;
    }
    for (const neighbor of region.neighbors) {
      if (ownerByMesoId.get(neighbor.id) === defenderId) {
        return [region.id, neighbor.id];
      }
    }
  }
  return null;
}
