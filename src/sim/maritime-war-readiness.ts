import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import { canReachControlled } from "./ai-geography";
import { isOperationalCombatShip } from "./maritime-escort";
import { getCachedMaritimePositioningSegments, getCachedMaritimeRoute, isOperationalTransport } from "./maritime-supply";
import { getFleetTransportCapacity } from "./unit-capabilities";
import { getUnitCombatStrength } from "./unit-strength";
import { getAdjacentNationPairs, getNeighborsById, getPortTargetsByNation } from "./world-cache";
import type { WorldState } from "./world-state";

export function hasWarApproach(world: WorldState, attacker: NationId, defender: NationId): boolean {
  return getAdjacentNationPairs(world).some(([a, b]) =>
    (a === attacker && b === defender) || (b === attacker && a === defender)) ||
    assessMaritimeWarReadiness(world, attacker, defender) !== null;
}

/** Returns the shortest viable route in segments, or null if the expedition is infeasible. */
export function assessMaritimeWarReadiness(world: WorldState, attacker: NationId, defender: NationId): number | null {
  const settings = WORLD_BALANCE.war.declare;
  const ports = getPortTargetsByNation(world);
  const departures = ports.get(attacker) ?? [];
  const destinations = ports.get(defender) ?? [];
  if (!departures.length || !destinations.length) return null;

  const logistics = world.supplyAssessment.maritimeLogistics.assignmentByTransportId;
  const amphibious = world.amphibiousOperations;
  const available = world.units.filter((unit) => unit.nationId === attacker &&
    unit.manpower > 0 && unit.org > 0 && Number.isFinite(unit.moveTicksPerRegion) &&
    !amphibious.operationByUnitId.has(unit.id) && !amphibious.capabilityDemandByUnitId.has(unit.id));
  const transports = available.filter((unit) => isOperationalTransport(unit) &&
    !logistics.has(unit.id) && unit.cargoUnits.length === 0);
  const escorts = available.filter((unit) => isOperationalCombatShip(unit));
  if (transports.length < settings.maritimeMinimumTransports ||
    escorts.length < settings.maritimeMinimumCombatShips) return null;

  const enemy = world.units.filter((unit) => unit.nationId === defender && unit.manpower > 0 && unit.org > 0);
  const enemyFleetStrength = enemy.filter((unit) => isOperationalCombatShip(unit))
    .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  const coastalDefense = destinations.map((port) => {
    const area = new Set([port, ...getNeighborsById(world).get(port) ?? []]);
    const strength = enemy.filter((unit) => unit.domain === "land" && area.has(unit.regionId))
      .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    return { port, strength };
  });

  let shortest = Infinity;
  const connectivity = world.supplyAssessment.maritimeConnectivity;
  for (const departure of departures) {
    const reachable = (unit: typeof available[number]) =>
      getCachedMaritimePositioningSegments(world, unit.regionId, departure) !== null;
    const fleet = transports.filter(reachable);
    const escortFleet = escorts.filter(reachable);
    if (fleet.length < settings.maritimeMinimumTransports ||
      escortFleet.length < settings.maritimeMinimumCombatShips ||
      escortFleet.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0) <
        enemyFleetStrength * settings.maritimeSuperiorityRatio) continue;

    const waveSize = Math.floor(getFleetTransportCapacity(fleet) / 2);
    const troops = available.filter((unit) => unit.domain === "land" &&
      canReachControlled(world, attacker, unit.regionId, departure))
      .map(getUnitCombatStrength).sort((a, b) => b - a);
    // Reserve capacity and troops for a second wave before committing the first.
    const unitsPerWave = Math.min(waveSize, Math.floor(troops.length / 2));
    if (unitsPerWave < settings.maritimeMinimumUnitsPerWave) continue;
    const firstWave = troops.slice(0, unitsPerWave).reduce((sum, strength) => sum + strength, 0);
    const secondWave = troops.slice(unitsPerWave, unitsPerWave * 2).reduce((sum, strength) => sum + strength, 0);
    if (firstWave + secondWave < settings.maritimeMinimumLandStrength) continue;
    for (const target of coastalDefense) {
      if (firstWave < target.strength * settings.maritimeSuperiorityRatio) continue;
      const route = getCachedMaritimeRoute(world, connectivity, departure, target.port);
      if (route) shortest = Math.min(shortest, route.length - 1);
    }
  }
  return shortest <= settings.maritimeMaxRouteSegments ? shortest : null;
}
