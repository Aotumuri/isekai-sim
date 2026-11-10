import type { MesoRegionId } from "../worldgen/meso-region";
import { getPlayerNation, type PlayerNation } from "./player-nation";
import type { UnitId, UnitState } from "./unit";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function setPlayerCommandMode(world: WorldState, mode: PlayerNation["commandMode"]): void {
  const player = getPlayerNation(world);
  if (!player || player.commandMode === mode) return;
  player.commandMode = mode;
  player.landOrders.clear();
  player.commandRevision += 1;
}

export function isPlayerDirectedLandUnit(player: PlayerNation | undefined, unit: UnitState): boolean {
  return player?.nationId === unit.nationId &&
    (player.commandMode === "manual" || player.landOrders.has(unit.id));
}

export function issuePlayerLandOrder(
  world: WorldState, destination: MesoRegionId, units: UnitId | number,
): number {
  const player = getPlayerNation(world);
  if (!player || (typeof units === "number" ? player.commandMode !== "assisted" : player.commandMode !== "manual")) return 0;
  if (typeof units === "number" && (!Number.isSafeInteger(units) || units < 1)) return 0;
  const regions = getMesoById(world);
  const owners = getOwnerByMesoId(world);
  const neighbors = getNeighborsById(world);
  const wars = buildWarAdjacency(world.wars);
  const passable = (id: MesoRegionId) => {
    const owner = owners.get(id);
    return regions.get(id)?.type === "land" &&
      (owner === player.nationId || (!!owner && isAtWar(player.nationId, owner, wars)));
  };
  if (!passable(destination)) return 0;
  const distances = new Map([[destination, 0]]);
  const queue = [destination];
  for (const id of queue) {
    for (const next of neighbors.get(id) ?? []) {
      if (!passable(next) || distances.has(next)) continue;
      distances.set(next, distances.get(id)! + 1);
      queue.push(next);
    }
  }
  const selected = world.units.filter((unit) => unit.domain === "land" && unit.nationId === player.nationId &&
    unit.manpower > 0 && distances.has(unit.regionId) &&
    !world.amphibiousOperations.operationByUnitId.has(unit.id) &&
    !world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) &&
    (typeof units === "number" ? !player.landOrders.has(unit.id) : unit.id === units))
    .sort((a, b) => distances.get(a.regionId)! - distances.get(b.regionId)! || a.id.localeCompare(b.id))
    .slice(0, typeof units === "number" ? units : 1);
  for (const unit of selected) player.landOrders.set(unit.id, destination);
  if (selected.length) player.commandRevision += 1;
  return selected.length;
}

export function clearPlayerLandOrders(world: WorldState): void {
  const player = getPlayerNation(world);
  if (!player?.landOrders.size) return;
  player.landOrders.clear();
  player.commandRevision += 1;
}
