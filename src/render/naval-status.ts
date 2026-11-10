import { LANDING_PHASE_LABELS } from "./japanese-labels";
import { getNationName } from "../sim/nation-identity";
import { getCoastalSupportModifier } from "../sim/coastal-support";
import { getNavalUnitOwnership } from "../sim/naval-strategy";
import type { UnitState } from "../sim/unit";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";

const MISSION_NAMES = {
  ESCORT: "船団護衛", RAID: "船団襲撃", INTERCEPT: "敵艦隊の迎撃",
  BLOCKADE: "港湾封鎖", SUPPORT: "沿岸砲撃", RESERVE: "予備",
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
  if (!owner) return "海軍命令：配属待ち";
  if (owner.controller === "AMPHIBIOUS_OPERATION") {
    const operation = world.amphibiousOperations.operationByUnitId.get(unit.id)!;
    const role = owner.missionType === "ESCORT" ? "上陸船団の護衛" : "部隊輸送";
    return `海軍命令：${role} → ${operation.destinationPortId} (${LANDING_PHASE_LABELS[operation.phase]})`;
  }
  if (owner.controller === "AMPHIBIOUS_CAPABILITY") {
    return `海軍命令：上陸艦隊を集結中 (${owner.missionType === "ESCORT" ? "護衛" : "輸送"})`;
  }
  if (owner.controller === "MARITIME_LOGISTICS") {
    if (owner.missionType === "RESERVE") return "海軍命令：予備輸送船";
    const convoy = owner.assignmentId ? world.supplyAssessment.convoys.convoyByLinkId.get(owner.assignmentId) : undefined;
    return convoy ? `海軍命令：補給船団 → ${convoy.route.destinationPortId} (${convoy.state})`
      : "海軍命令：補給輸送船を移動中";
  }
  const mission = world.supplyAssessment.navalStrategy.missionById.get(owner.missionId);
  if (!mission) return "海軍命令：配属待ち";
  const target = mission.targetCoastId ?? mission.targetPortId ?? mission.targetSeaRegionId;
  return `海軍命令：${MISSION_NAMES[mission.type]}${target ? ` → ${target}` : ""}${mission.status === "UNAVAILABLE" ? "（実行不可）" : ""}`;
}

export function formatCoastalSupportStatus(world: WorldState, coastId: MesoRegionId): string[] {
  const nations = new Set(world.supplyAssessment.navalStrategy.missions.filter((mission) =>
    mission.type === "SUPPORT" && mission.targetCoastId === coastId).map((mission) => mission.nationId));
  return [...nations].sort().slice(0, 3).map((nationId) => {
    const bonus = Math.round((getCoastalSupportModifier(world, nationId, coastId) - 1) * 100);
    return `沿岸支援：${getNationName(world, nationId)} ${bonus > 0 ? `+${bonus}% 組織率への圧力` : "未配置または交戦中"}`;
  });
}
