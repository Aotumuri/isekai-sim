import { culturalDistance } from "./annexation";
import { getRelation, hasTreaty } from "./diplomacy";
import { startDiplomaticWar } from "./diplomatic-crises";
import { changeResource } from "./international-trade";
import type { NationRuntime } from "./nation-runtime";
import { getNationName } from "./nation-identity";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { releaseSubjectGovernment } from "./subject-governments";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function updateSubjectAutonomy(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy" || world.time.slowTick % 10 !== 0 ||
    !world.nations.some((nation) => nation.subjectGovernment)) return;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
  const land = new Map<NationRuntime, { districts: number; deposits: Set<string> }>();
  for (const [id, owner] of owners) {
    const nation = nations.get(owner), region = regions.get(id);
    if (!nation || !region || region.type === "sea") continue;
    const assets = land.get(nation) ?? { districts: 0, deposits: new Set<string>() };
    assets.districts++;
    if (region.resource && (!world.occupation.mesoById.has(id) || world.occupation.mesoById.get(id) === owner)) {
      assets.deposits.add(region.resource);
    }
    land.set(nation, assets);
  }
  for (const subject of world.nations) {
    const government = subject.subjectGovernment;
    const overlord = government && nations.get(government.overlordId);
    const assets = land.get(subject), overlordAssets = overlord && land.get(overlord);
    if (!government || !overlord || !assets || !overlordAssets) continue;
    let shortage = 0;
    for (const resource of ["steel", "fuel"] as const) {
      if (assets.deposits.has(resource) || subject.resources[resource] >= 12) continue;
      const aid = Math.max(0, Math.min(3, overlord.resources[resource] - 20, 12 - subject.resources[resource]));
      changeResource(overlord, resource, -aid);
      changeResource(subject, resource, aid);
      shortage += 1 - aid / 3;
    }
    const populations = world.regionalPopulations;
    const gap = culturalDistance(populations?.get(subject.capitalMesoId), populations?.get(overlord.capitalMesoId));
    const power = Math.min(1.5, assets.districts / overlordAssets.districts);
    const relation = getRelation(world, subject.id, overlord.id);
    const strain = (1 - Math.max(0, Math.min(1, overlord.warCooperation))) * 2;
    const change = power * 3 + gap * 2 + strain + shortage - relation.trust * 0.04 - 0.5;
    government.autonomy = Math.max(0, Math.min(100, (government.autonomy ?? 0) + change));
    if (government.autonomy < 100 || hasTreaty(world, subject.id, overlord.id, "truce")) continue;
    if (!releaseSubjectGovernment(world, overlord.id, subject.id)) continue;
    recordSimulationEvent(world, { category: "politics", nationIds: [subject.id, overlord.id],
      message: `${getNationName(world, subject.id)} broke from ${getNationName(world, overlord.id)} and declared independence.` });
    if (power >= 0.6) startDiplomaticWar(world, subject.id, overlord.id);
  }
}
