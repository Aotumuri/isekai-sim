import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isSafeControlledRegion } from "./ai-geography";
import { changeResource } from "./international-trade";
import { isNationActive } from "./nation-active";
import { completePortConstruction, getPortSiteIssue, PORT_CONSTRUCTION_COST } from "./port-construction";
import { recordSimulationEvent } from "./simulation-settings";
import { isNationRegionSupplied } from "./supply-assessment";
import { spendTreasury } from "./treasury";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export const PUBLIC_WORKS = {
  city: { cash: 45, steel: 80, fuel: 20, duration: 45 },
  port: { cash: 30, ...PORT_CONSTRUCTION_COST, duration: 30 },
} as const;
export type PublicWorkKind = keyof typeof PUBLIC_WORKS;

export interface PublicWork {
  nationId: NationId;
  kind: PublicWorkKind;
  remaining: number;
  lastTick: number;
  paused: boolean;
}

function siteIssue(world: WorldState, id: NationId, district: MesoRegionId, kind: PublicWorkKind): string | null {
  if (kind === "port") return getPortSiteIssue(world, id, district);
  const region = getMesoById(world).get(district);
  if (!region || region.type === "sea" || region.building !== null || getOwnerByMesoId(world).get(district) !== id) {
    return "Select an empty district you own.";
  }
  return isSafeControlledRegion(world, id, district, { excludeBattles: true }) && isNationRegionSupplied(world, id, district)
    ? null : "The district must be under your control, safe and supplied.";
}

export function getPublicWorkIssue(world: WorldState, id: NationId, district: MesoRegionId, kind: PublicWorkKind): string | null {
  const nation = world.nations.find((item) => item.id === id);
  if (!nation?.treasury || !isNationActive(nation)) return "An active treasury is required.";
  if (world.publicWorks?.has(district)) return "A public works project already uses this site.";
  if ([...(world.publicWorks?.values() ?? [])].some((project) => project.nationId === id)) return "This nation already has a project.";
  const issue = siteIssue(world, id, district, kind);
  if (issue) return issue;
  const cost = PUBLIC_WORKS[kind];
  if (nation.treasury.balance < cost.cash || nation.resources.steel < cost.steel || nation.resources.fuel < cost.fuel) {
    return "Insufficient cash, steel or fuel.";
  }
  return null;
}

export function commissionPublicWork(world: WorldState, id: NationId, district: MesoRegionId, kind: PublicWorkKind): boolean {
  if (getPublicWorkIssue(world, id, district, kind)) return false;
  const nation = world.nations.find((item) => item.id === id)!;
  const cost = PUBLIC_WORKS[kind];
  if (!spendTreasury(nation.treasury, "construction", cost.cash)) return false;
  changeResource(nation, "steel", -cost.steel);
  changeResource(nation, "fuel", -cost.fuel);
  (world.publicWorks ??= new Map()).set(district, { nationId: id, kind, remaining: cost.duration, lastTick: world.time.slowTick, paused: false });
  return true;
}

export function updatePublicWorks(world: WorldState): void {
  if (!world.publicWorks?.size) return;
  const regions = getMesoById(world), owners = getOwnerByMesoId(world);
  for (const [district, project] of world.publicWorks) {
    const { nationId, kind } = project;
    const region = regions.get(district);
    if (!region || region.building !== null || owners.get(district) !== nationId) {
      world.publicWorks.delete(district);
      recordSimulationEvent(world, { category: "politics", nationIds: [nationId], message: `${nationId} lost its ${kind} construction site.` });
      continue;
    }
    const elapsed = Math.max(0, world.time.slowTick - project.lastTick);
    project.lastTick = world.time.slowTick;
    project.paused = !!siteIssue(world, nationId, district, kind);
    if (project.paused) continue;
    project.remaining -= elapsed;
    if (project.remaining > 0) continue;
    world.publicWorks.delete(district);
    if (kind === "port") {
      completePortConstruction(world, nationId, district);
    } else {
      region.building = "city";
      world.buildingVersion++;
      const nation = world.nations.find((item) => item.id === nationId);
      if (nation) nation.initialCityCount++;
      recordSimulationEvent(world, { category: "politics", nationIds: [nationId],
        message: `${nationId} founded a city in District ${district.replace("meso-", "")}.` });
    }
  }
}
