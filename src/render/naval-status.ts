import { getNationName } from "../sim/nation-identity";
import { getCoastalSupportModifier } from "../sim/coastal-support";
import { getNavalUnitOwnership } from "../sim/naval-strategy";
import type { UnitState } from "../sim/unit";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";

const MISSION_NAMES = {
  ESCORT: "Convoy escort", RAID: "Convoy raiding", INTERCEPT: "Intercepting enemy fleet",
  BLOCKADE: "Port blockade", SUPPORT: "Shore bombardment", RESERVE: "Reserve",
} as const;

export function summarizeNavy(world: WorldState, nationId: NationId): {
  combatShips: number; transports: number; activeRoutes: number; totalRoutes: number;
} {
  const ships = world.units.filter((unit) => unit.nationId === nationId && unit.domain === "naval" && unit.manpower > 0);
  const links = world.supplyAssessment.maritimeLinks.filter((link) => link.nationId === nationId);
  return {
    combatShips: ships.filter((unit) => unit.type === "CombatShip").length,
    transports: ships.filter((unit) => unit.type === "TransportShip").length,
    activeRoutes: links.filter((link) => link.active).length, totalRoutes: links.length,
  };
}

export function formatNavalUnitStatus(world: WorldState, unit: UnitState): string | null {
  if (unit.domain !== "naval") return null;
  const owner = getNavalUnitOwnership(world, unit.id);
  if (!owner) return "Naval order: Awaiting assignment";
  if (owner.controller === "AMPHIBIOUS_OPERATION") {
    const operation = world.amphibiousOperations.operationByUnitId.get(unit.id)!;
    const role = owner.missionType === "ESCORT" ? "Landing escort" : "Troop transport";
    return `Naval order: ${role} → ${operation.destinationPortId} (${operation.phase})`;
  }
  if (owner.controller === "AMPHIBIOUS_CAPABILITY") {
    return `Naval order: Assembling landing fleet (${owner.missionType === "ESCORT" ? "escort" : "transport"})`;
  }
  if (owner.controller === "MARITIME_LOGISTICS") {
    if (owner.missionType === "RESERVE") return "Naval order: Transport reserve";
    const convoy = owner.assignmentId ? world.supplyAssessment.convoys.convoyByLinkId.get(owner.assignmentId) : undefined;
    return convoy ? `Naval order: Supply convoy → ${convoy.route.destinationPortId} (${convoy.state})`
      : "Naval order: Supply transport positioning";
  }
  const mission = world.supplyAssessment.navalStrategy.missionById.get(owner.missionId);
  if (!mission) return "Naval order: Awaiting assignment";
  const target = mission.targetCoastId ?? mission.targetPortId ?? mission.targetSeaRegionId;
  return `Naval order: ${MISSION_NAMES[mission.type]}${target ? ` → ${target}` : ""}${mission.status === "UNAVAILABLE" ? " (unavailable)" : ""}`;
}

export function formatCoastalSupportStatus(world: WorldState, coastId: MesoRegionId): string[] {
  const nations = new Set(world.supplyAssessment.navalStrategy.missions.filter((mission) =>
    mission.type === "SUPPORT" && mission.targetCoastId === coastId).map((mission) => mission.nationId));
  return [...nations].sort().slice(0, 3).map((nationId) => {
    const bonus = Math.round((getCoastalSupportModifier(world, nationId, coastId) - 1) * 100);
    return `Shore support: ${getNationName(world, nationId)} ${bonus > 0 ? `+${bonus}% organization pressure` : "not on station / contested"}`;
  });
}
