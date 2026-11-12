import type { NationId } from "../../worldgen/nation";
import type { UnitState } from "../unit";
import type { WorldState } from "../world-state";
import { getOpposingFrontSide } from "../land-fronts";
import { getUnitCombatStrength } from "../unit-strength";

/** Fractional forecast of a movable surplus, not an order or a new lease.
 * A partial projection receives its share of the front's withdrawable force. */
export function projectedSurplusFraction(totalStrength: number, floor: number): number {
  return totalStrength > 0 ? Math.max(0, Math.min(1, (totalStrength - Math.max(0, floor)) / totalStrength)) : 0;
}

/** Respect the same reservations as execution. Existing friendly front force
 * still contributes against its opponent; another theater keeps its floor. */
export function forecastCampaignForceShares(
  world: WorldState, nationId: NationId, opponentId: NationId, units: UnitState[],
): Map<string, number> {
  const shares = new Map<string, number>();
  const totals = new Map<string, number>();
  const eligible = units.filter((unit) => canProjectCampaignUnit(world, unit, opponentId));
  for (const unit of eligible) {
    const front = world.frontAllocations.frontIdByUnitId.get(unit.id);
    if (front) totals.set(front, (totals.get(front) ?? 0) + getUnitCombatStrength(unit));
  }
  for (const unit of eligible) {
    const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
    const front = frontId && world.landFronts.operationalSectorsById.get(frontId);
    const otherFront = front && getOpposingFrontSide(front, nationId)?.nationId !== opponentId;
    const floor = frontId && world.frontlineCoverage.coverageBySectorNation.get(`${frontId}::${nationId}`)?.minimumRequiredStrength;
    shares.set(unit.id, otherFront ? projectedSurplusFraction(totals.get(frontId!) ?? 0, floor ?? 0) : 1);
  }
  return shares;
}

function canProjectCampaignUnit(world: WorldState, unit: UnitState, opponentId: NationId): boolean {
  if (world.playerNation?.landOrders.has(unit.id) ||
    world.retreatPlans.retreatIdByUnitId.has(unit.id) || world.reorganization.planIdByUnitId.has(unit.id) ||
    world.amphibiousOperations.operationByUnitId.has(unit.id) || world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id)) return false;
  const operationId = world.offensiveOperations.operationIdByUnitId.get(unit.id);
  const operation = operationId && world.offensiveOperations.operations.find((op) => op.id === operationId);
  if (operation && operation.enemyNationId !== opponentId) return false;
  if (!world.strategicReserves.reserveNationByUnitId.has(unit.id)) return true;
  const deployment = world.strategicReserves.reservesByNationId.get(unit.nationId)?.deployment;
  const front = deployment?.targetFrontId && world.landFronts.operationalSectorsById.get(deployment.targetFrontId);
  return !!deployment && deployment.status !== "returning" && deployment.unitIds.includes(unit.id) &&
    !!front && getOpposingFrontSide(front, unit.nationId)?.nationId === opponentId;
}
