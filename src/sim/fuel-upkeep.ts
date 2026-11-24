import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import type { UnitState, UnitType } from "./unit";

export function getUnitFuelUse(type: UnitType): number {
  return Math.max(0, Math.round(WORLD_BALANCE.unit.types[type].fuelUse ?? 0));
}

export interface UpkeepRequest { unit: UnitState; cost: number }

export function collectFuelUpkeep(units: readonly UnitState[], activeNations: ReadonlyMap<NationId, unknown>) {
  const requests = new Map<NationId, UpkeepRequest[]>();
  for (const unit of units) {
    // Embarked units are carried by their transport, even when they have a fuel cost on land.
    for (const cargo of unit.cargoUnits) {
      if (getUnitFuelUse(cargo.type) > 0) setFuelStatus(cargo, false);
    }
    const cost = getUnitFuelUse(unit.type) * (unit.design?.fuelUse ?? 1);
    if (cost <= 0) continue;
    if (!activeNations.has(unit.nationId) || unit.manpower <= 0) {
      setFuelStatus(unit, false);
      continue;
    }
    const request = { unit, cost };
    const list = requests.get(unit.nationId);
    if (list) list.push(request);
    else requests.set(unit.nationId, [request]);
  }
  return requests;
}

/** In field order, pay full upkeep where possible. Unused fuel stays in stock. */
export function allocateFuelUpkeep(requests: readonly UpkeepRequest[], available: number) {
  let demand = 0, consumed = 0, transportAvailabilityChanged = false;
  for (const { unit, cost } of requests) {
    demand += cost;
    // Tolerate roundoff at exact coverage without allowing a negative stock.
    const supplied = available + 1e-9 >= cost;
    if (unit.type === "TransportShip" && supplied !== Number.isFinite(unit.moveTicksPerRegion)) {
      transportAvailabilityChanged = true;
    }
    if (supplied) {
      const paid = Math.min(available, cost);
      available -= paid;
      consumed += paid;
    }
    setFuelStatus(unit, supplied);
  }
  return { demand, consumed, transportAvailabilityChanged };
}

function setFuelStatus(unit: UnitState, supplied: boolean): void {
  if (supplied) {
    const settings = WORLD_BALANCE.unit.types[unit.type];
    unit.moveTicksPerRegion = Math.max(1, Math.round(settings.moveTicksPerRegion));
    unit.combatPower = Math.max(0, settings.combatPower);
  } else {
    unit.moveTicksPerRegion = Number.POSITIVE_INFINITY;
    unit.combatPower = 0;
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}
