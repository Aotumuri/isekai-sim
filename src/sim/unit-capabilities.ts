import { WORLD_BALANCE } from "../data/balance";
import type { UnitState } from "./unit";
import type { WeaponDesign } from "./research";
export function getDesignTransportCapacity(design?: WeaponDesign): number {
  return Math.max(1, Math.floor((WORLD_BALANCE.unit.navalTransportCapacity ?? 10) * (design?.capacity ?? 1) + 1e-9));
}
export function getUnitTransportCapacity(unit: UnitState): number { return unit.type === "TransportShip" ? getDesignTransportCapacity(unit.design) : 0; }
export function getFleetTransportCapacity(units: readonly UnitState[]): number { return units.reduce((sum, unit) => sum + getUnitTransportCapacity(unit), 0); }
export function getDesignUtility(design?: WeaponDesign): number {
  return (design?.firepower ?? 1) * (design?.reliability ?? 1) * (design?.handling ?? 1) *
    Math.sqrt((design?.armor ?? 1) * (design?.mobility ?? 1)) * (design?.family === "TransportShip" ? design.capacity ?? 1 : 1) /
    Math.pow((design?.weaponCost ?? 1) * (design?.fuelUse ?? 1), 0.1);
}
/** Build the entire manifest before embarking anybody, so insufficient capacity never strands or deletes a partial force. */
export function planTransportLoading(transports: readonly UnitState[], force: readonly UnitState[]): { transport: UnitState; cargo: UnitState[] }[] | null {
  if (transports.reduce((sum, unit) => sum + Math.max(0, getUnitTransportCapacity(unit) - unit.cargoUnits.length), 0) < force.length) return null;
  let index = 0;
  return transports.map((transport) => {
    const room = Math.max(0, getUnitTransportCapacity(transport) - transport.cargoUnits.length);
    const cargo = force.slice(index, index + room); index += cargo.length;
    return { transport, cargo };
  });
}
