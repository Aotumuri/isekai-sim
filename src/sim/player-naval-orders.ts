import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import { isAmphibiousOwnedUnit } from "./amphibious";
import { isEffectivelyControlledPort } from "./maritime-supply";
import { buildNavalPositioningRoute, moveNavalUnitToward } from "./naval-pathfinding";
import { getManualPlayerNationId, getPlayerNation } from "./player-nation";
import type { UnitId } from "./unit";
import { getMesoById } from "./world-cache";
import type { WorldState } from "./world-state";

export function issuePlayerNavalOrder(world: WorldState, unitId: UnitId, target: MesoRegionId): boolean {
  const player = getPlayerNation(world);
  const unit = world.units.find(({ id }) => id === unitId);
  if (player?.commandMode !== "manual" || unit?.domain !== "naval" || unit.nationId !== player.nationId ||
    unit.manpower <= 0 || isAmphibiousOwnedUnit(world, unit.id) || !isValidDestination(world, unit.nationId, target) ||
    !buildNavalPositioningRoute(world, unit.regionId, [target]).length) return false;
  player.navalOrders.set(unitId, target);
  return true;
}

export function updatePlayerNavalOrders(world: WorldState, dtMs: number): void {
  const nationId = getManualPlayerNationId(world);
  if (!nationId) return;
  const orders = world.playerNation!.navalOrders;
  for (const unit of world.units) {
    if (unit.nationId !== nationId || unit.domain !== "naval" || isAmphibiousOwnedUnit(world, unit.id)) continue;
    const target = orders.get(unit.id);
    if (!target || !isValidDestination(world, nationId, target)) {
      orders.delete(unit.id);
      unit.moveTargetId = null;
      unit.moveToId = null;
      unit.moveFromId = null;
      unit.moveProgressMs = 0;
      continue;
    }
    moveNavalUnitToward(world, unit, target, dtMs);
    if (!unit.moveTargetId && unit.regionId !== target) orders.delete(unit.id);
  }
}

function isValidDestination(world: WorldState, nationId: NationId, target: MesoRegionId): boolean {
  return getMesoById(world).get(target)?.type === "sea" || isEffectivelyControlledPort(world, nationId, target);
}
