import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isSafeControlledRegion } from "./ai-geography";
import { changeResource } from "./international-trade";
import { isNationActive } from "./nation-active";
import { recordSimulationEvent } from "./simulation-settings";
import { isNationRegionSupplied } from "./supply-assessment";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export const PORT_CONSTRUCTION_COST = { steel: 120, fuel: 40 } as const;

export function getPortConstructionIssue(world: WorldState, nationId: NationId, regionId: MesoRegionId): string | null {
  const nation = world.nations.find((item) => item.id === nationId && isNationActive(item));
  const regions = getMesoById(world);
  const region = regions.get(regionId);
  if (!nation || !region || region.type === "sea" || region.building !== null ||
    getOwnerByMesoId(world).get(regionId) !== nationId ||
    !region.neighbors.some(({ id }) => regions.get(id)?.type === "sea")) {
    return "Select an empty coastal district you own.";
  }
  if (!isSafeControlledRegion(world, nationId, regionId, { excludeBattles: true }) ||
    !isNationRegionSupplied(world, nationId, regionId)) {
    return "The district must be under your control, safe and supplied.";
  }
  if (nation.resources.steel < PORT_CONSTRUCTION_COST.steel || nation.resources.fuel < PORT_CONSTRUCTION_COST.fuel) {
    return "Insufficient steel or fuel.";
  }
  return null;
}

export function constructPort(world: WorldState, nationId: NationId, regionId: MesoRegionId): boolean {
  if (getPortConstructionIssue(world, nationId, regionId)) return false;

  const nation = world.nations.find((item) => item.id === nationId)!;
  changeResource(nation, "steel", -PORT_CONSTRUCTION_COST.steel);
  changeResource(nation, "fuel", -PORT_CONSTRUCTION_COST.fuel);
  getMesoById(world).get(regionId)!.building = "port";
  world.buildingVersion += 1;
  recordSimulationEvent(world, { category: "military", nationIds: [nationId],
    message: `${nationId} built a port in District ${regionId.replace("meso-", "")}.` });
  return true;
}
