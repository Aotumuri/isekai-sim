import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isOperationalCombatShip } from "./maritime-escort";
import { buildNavalPositioningRoute } from "./naval-pathfinding";
import { isAmphibiousOwnedUnit } from "./amphibious";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

/** Support actual coastal fighting and committed landings, never empty coasts. */
export function getCoastalSupportTargets(world: WorldState, nationId: NationId): MesoRegionId[] {
  const warAdjacency = buildWarAdjacency(world.wars);
  const ownerById = getOwnerByMesoId(world);
  const targets = new Set<MesoRegionId>();
  for (const unit of world.units) {
    if (unit.domain !== "land" || unit.manpower <= 0 || unit.org <= 0 || !unit.moveToId) continue;
    const owner = ownerById.get(unit.moveToId);
    if (!owner || !isAtWar(unit.nationId, owner, warAdjacency)) continue;
    if (unit.nationId === nationId || owner === nationId) targets.add(unit.moveToId);
  }
  for (const operation of world.amphibiousOperations.operations) {
    if (operation.phase !== "transporting") continue;
    const owner = ownerById.get(operation.destinationPortId);
    if (owner && isAtWar(operation.nationId, owner, warAdjacency) &&
      (operation.nationId === nationId || owner === nationId)) targets.add(operation.destinationPortId);
  }
  const mesoById = getMesoById(world);
  return [...targets].filter((id) => mesoById.get(id)?.type !== "sea" &&
    getCoastalSeaRegions(world, id).length > 0).sort();
}

export function getCoastalSeaRegions(world: WorldState, coastId: MesoRegionId): MesoRegionId[] {
  const mesoById = getMesoById(world);
  return (mesoById.get(coastId)?.neighbors ?? []).map((neighbor) => neighbor.id)
    .filter((id) => mesoById.get(id)?.type === "sea").sort();
}

export function canReachCoast(world: WorldState, nationId: NationId, coastId: MesoRegionId): boolean {
  const seas = getCoastalSeaRegions(world, coastId);
  const starts = new Set(world.units.filter((unit) => isOperationalCombatShip(unit, nationId) &&
    !isAmphibiousOwnedUnit(world, unit.id)).map((unit) => unit.regionId));
  // A supplied home port can build a fleet even when no ship exists yet.
  for (const [portId, ownerId] of getOwnerByMesoId(world)) {
    if (ownerId === nationId && getMesoById(world).get(portId)?.building === "port") starts.add(portId);
  }
  return [...starts].some((start) => buildNavalPositioningRoute(world, start, seas, true).length > 0);
}

/** Bounded organization pressure. Ships must be on station in uncontested sea. */
export function getCoastalSupportModifier(world: WorldState, nationId: NationId, coastId: MesoRegionId): number {
  const seas = new Set(getCoastalSeaRegions(world, coastId));
  if (seas.size === 0) return 1;
  const warAdjacency = buildWarAdjacency(world.wars);
  const contestedSeas = new Set(world.units.filter((unit) =>
    seas.has(unit.regionId) && isOperationalCombatShip(unit) && unit.combatPower > 0 &&
    isAtWar(nationId, unit.nationId, warAdjacency)).map((unit) => unit.regionId));
  let ships = 0;
  for (const unit of world.units) {
    if (!isOperationalCombatShip(unit, nationId) || unit.combatPower <= 0 || unit.moveToId ||
      !seas.has(unit.regionId) || contestedSeas.has(unit.regionId) || isAmphibiousOwnedUnit(world, unit.id)) continue;
    const mission = world.supplyAssessment.navalStrategy.missionByShipId.get(unit.id);
    if (mission?.type === "SUPPORT" && mission.status === "ACTIVE" && mission.targetCoastId === coastId) ships += 1;
  }
  const config = WORLD_BALANCE.unit.naval.strategy;
  return 1 + Math.min(config.maximumShoreSupportBonus, ships * config.shoreSupportBonusPerShip);
}
