import { createUnitForType } from "../../src/sim/create-units";
import { updateOccupation } from "../../src/sim/occupation";
import { createUnitId } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";

export function startAdjacentWars(world: WorldState, desiredCount: number): number {
  const ownerByMesoId = buildOwnerByMesoId(world);
  const mesoById = new Map(world.mesoRegions.map((meso) => [meso.id, meso]));
  const pairs = new Map<string, [NationId, NationId]>();
  for (const meso of world.mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    for (const neighbor of meso.neighbors) {
      const neighborMeso = mesoById.get(neighbor.id);
      const neighborOwner = ownerByMesoId.get(neighbor.id);
      if (!neighborMeso || neighborMeso.type === "sea" || !neighborOwner) {
        continue;
      }
      if (owner === neighborOwner) {
        continue;
      }
      const [a, b] = owner < neighborOwner ? [owner, neighborOwner] : [neighborOwner, owner];
      pairs.set(`${a}:${b}`, [a, b]);
    }
  }

  let added = 0;
  for (const [a, b] of [...pairs.values()].sort(([a1, b1], [a2, b2]) =>
    `${a1}:${b1}`.localeCompare(`${a2}:${b2}`),
  )) {
    if (added >= desiredCount) {
      break;
    }
    if (declareWar(world.wars, a, b, world.time.fastTick, true)) {
      added += 1;
    }
  }
  return added;
}

export function ensureLandUnitCount(world: WorldState, targetCount: number): void {
  const activeNations = world.nations.filter((nation) => nation.macroRegionIds.length > 0);
  if (activeNations.length === 0) {
    return;
  }
  let landCount = world.units.filter((unit) => unit.domain === "land").length;
  while (landCount < targetCount) {
    const nation = activeNations[landCount % activeNations.length];
    const id = createUnitId(world.unitIdCounter);
    const type = world.unitIdCounter % 5 === 0 ? "Tank" : "Infantry";
    world.units.push(createUnitForType(id, nation.id, nation.capitalMesoId, type));
    world.unitIdCounter += 1;
    landCount += 1;
  }
}

export function forceOneOccupation(world: WorldState): boolean {
  const ownerByMesoId = buildOwnerByMesoId(world);
  const occupiedByUnit = new Set(world.units.map((unit) => unit.regionId));
  for (const war of world.wars) {
    const attacker = world.units.find(
      (unit) => unit.domain === "land" && unit.nationId === war.nationAId,
    );
    if (!attacker) {
      continue;
    }
    const target = world.mesoRegions.find(
      (meso) =>
        meso.type !== "sea" &&
        ownerByMesoId.get(meso.id) === war.nationBId &&
        !occupiedByUnit.has(meso.id),
    );
    if (!target) {
      continue;
    }
    attacker.regionId = target.id;
    attacker.moveTargetId = null;
    attacker.moveFromId = null;
    attacker.moveToId = null;
    attacker.moveProgressMs = 0;
    updateOccupation(world);
    return world.occupation.mesoById.get(target.id) === attacker.nationId;
  }
  return false;
}

export function buildOwnerByMesoId(world: WorldState): Map<MesoRegionId, NationId> {
  const owners = new Map<MesoRegionId, NationId>();
  for (const macro of world.macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      owners.set(mesoId, macro.nationId);
    }
  }
  return owners;
}
