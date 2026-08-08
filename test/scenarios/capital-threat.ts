import { createUnitForType } from "../../src/sim/create-units";
import { updateCapitalDefense } from "../../src/sim/capital-defense";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateNationFrontAllocations } from "../../src/sim/nation-front-allocations";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { createUnitId } from "../../src/sim/unit";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { buildOwnerByMesoId, startAdjacentWars } from "./scenario-utils";
import type { ScenarioSetup } from "./types";

export const setupCapitalThreat: ScenarioSetup = (world, options) => {
  if (startAdjacentWars(world, 1) !== 1) {
    throw new Error("capital-threat requires an adjacent war");
  }
  const war = world.wars[0];
  if (!war) {
    throw new Error("capital-threat war was not created");
  }
  const border = findBorderPair(world, war.nationAId, war.nationBId);
  if (!border) {
    throw new Error("capital-threat could not find its land border");
  }
  const [attackerBorderId, defenderBorderId] = border;
  const attacker = world.nations.find((nation) => nation.id === war.nationAId);
  const defender = world.nations.find((nation) => nation.id === war.nationBId);
  const defenderCapital = world.mesoRegions.find(
    (meso) => meso.id === defender?.capitalMesoId,
  );
  const threatenedCapital = world.mesoRegions.find(
    (meso) => meso.id === defenderBorderId,
  );
  if (!attacker || !defender || !threatenedCapital) {
    throw new Error("capital-threat nations or threatened capital are missing");
  }
  if (defenderCapital && defenderCapital.id !== threatenedCapital.id) {
    defenderCapital.building = "city";
  }
  threatenedCapital.building = "capital";
  defender.capitalMesoId = threatenedCapital.id;
  world.buildingVersion += 1;

  world.units = world.units.filter(
    (unit) => unit.nationId !== attacker.id && unit.nationId !== defender.id,
  );
  addForce(world, attacker.id, attackerBorderId, options.quick ? 18 : 36, 3);
  addForce(world, defender.id, defenderBorderId, options.quick ? 2 : 4, 0);

  const rearRegionIds = collectFriendlyRearRegions(
    world,
    defender.id,
    defenderBorderId,
  );
  const rearCount = options.quick ? 12 : 24;
  for (let index = 0; index < rearCount; index += 1) {
    addForce(
      world,
      defender.id,
      rearRegionIds[index % rearRegionIds.length] ?? defenderBorderId,
      1,
      index % 6 === 0 ? 1 : 0,
    );
  }

  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
};

function addForce(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  count: number,
  tankEvery: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const unit = createUnitForType(
      createUnitId(world.unitIdCounter),
      nationId,
      regionId,
      tankEvery > 0 && index % tankEvery === 0 ? "Tank" : "Infantry",
    );
    world.unitIdCounter += 1;
    world.units.push(unit);
  }
}

function findBorderPair(
  world: WorldState,
  attackerId: NationId,
  defenderId: NationId,
): [MesoRegionId, MesoRegionId] | null {
  const ownerByMesoId = buildOwnerByMesoId(world);
  for (const meso of world.mesoRegions) {
    if (meso.type === "sea" || ownerByMesoId.get(meso.id) !== attackerId) continue;
    for (const neighbor of meso.neighbors) {
      if (ownerByMesoId.get(neighbor.id) === defenderId) {
        return [meso.id, neighbor.id];
      }
    }
  }
  return null;
}

function collectFriendlyRearRegions(
  world: WorldState,
  nationId: NationId,
  frontRegionId: MesoRegionId,
): MesoRegionId[] {
  const ownerByMesoId = buildOwnerByMesoId(world);
  const candidates = world.mesoRegions
    .filter(
      (meso) =>
        meso.type !== "sea" &&
        meso.id !== frontRegionId &&
        ownerByMesoId.get(meso.id) === nationId,
    )
    .sort(
      (a, b) =>
        distanceSquared(b, frontRegionId, world) -
        distanceSquared(a, frontRegionId, world),
    );
  return candidates
    .slice(0, Math.max(1, Math.min(4, candidates.length)))
    .map((meso) => meso.id);
}

function distanceSquared(
  region: { center: { x: number; y: number } },
  originId: MesoRegionId,
  world: WorldState,
): number {
  const origin = world.mesoRegions.find((meso) => meso.id === originId);
  if (!origin) return 0;
  const dx = region.center.x - origin.center.x;
  const dy = region.center.y - origin.center.y;
  return dx * dx + dy * dy;
}
