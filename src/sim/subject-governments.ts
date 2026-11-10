import type { FoodLevyRate } from "./subject-food-levy";
import type { NationId } from "../worldgen/nation";
import { getDiplomacyState, getRelation } from "./diplomacy";
import { leaveFaction } from "./factions";
import { getMilitaryAccessState, withdrawMilitaryVisitors } from "./military-access";
import { isNationActive } from "./nation-active";
import { getNationIdeology } from "./nation-identity";
import { setPoliticalMandate } from "./politics";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { findWar } from "./war-state";
import { getMesoById } from "./world-cache";
import type { WorldState } from "./world-state";

export interface SubjectGovernment {
  overlordId: NationId;
  establishedAtFastTick: number;
  autonomy?: number;
  foodLevy?: FoodLevyRate;
}

export function getSubjectOverlord(world: WorldState, subjectId: NationId): NationId | undefined {
  const subject = world.nations.find((nation) => nation.id === subjectId);
  const overlordId = subject?.subjectGovernment?.overlordId;
  return subject && isNationActive(subject) && overlordId &&
    world.nations.some((nation) => nation.id === overlordId && isNationActive(nation)) ? overlordId : undefined;
}

export function areSubjectPartners(world: WorldState, a: NationId, b: NationId): boolean {
  return getSubjectOverlord(world, a) === b || getSubjectOverlord(world, b) === a;
}

export function getPuppetTermsIssue(world: WorldState, overlord: NationId, target: NationId): string | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || !findWar(world.wars, overlord, target) ||
    ![overlord, target].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) {
    return "A puppet settlement requires two active governments at war.";
  }
  if (getSubjectOverlord(world, overlord) || getSubjectOverlord(world, target) ||
    world.nations.some((nation) => getSubjectOverlord(world, nation.id) === target)) {
    return "Neither government may be a subject, and the target must release its own subjects first.";
  }

  const regions = getMesoById(world);
  const land = world.macroRegions.filter((macro) => macro.nationId === target).flatMap((macro) => macro.mesoRegionIds)
    .filter((id) => regions.get(id)?.type !== "sea");
  const occupied = land.filter((id) => world.occupation.mesoById.get(id) === overlord);
  const hasCity = occupied.some((id) => {
    const building = regions.get(id)?.building;
    return building === "city" || building === "capital";
  });
  if (!hasCity || occupied.length < Math.ceil(land.length * 0.3)) {
    return "Occupy at least 30% of the target’s districts, including a city or capital.";
  }
  return null;
}

/** Installs an already accepted puppet settlement after the bilateral war ends. */
export function installSubjectGovernment(world: WorldState, overlordId: NationId, subjectId: NationId): void {
  const subject = world.nations.find((nation) => nation.id === subjectId)!;
  leaveFaction(world, subjectId, "puppet settlement");
  for (const relation of getDiplomacyState(world).relations.values()) {
    if (relation.nationAId !== subjectId && relation.nationBId !== subjectId) continue;
    relation.treaties = relation.treaties.filter((treaty) => treaty.type !== "alliance");
    relation.crisis = null;
  }
  subject.subjectGovernment = { overlordId, establishedAtFastTick: world.time.fastTick };
  setPoliticalMandate(world, subject, getNationIdeology(world, overlordId).id);
  const relation = getRelation(world, overlordId, subjectId);
  relation.opinion = Math.max(25, relation.opinion);
  relation.trust = Math.max(50, relation.trust);
  getMilitaryAccessState(world).version++;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [overlordId, subjectId],
    message: `${overlordId} installed a puppet government in ${subjectId}.` });
}

export function releaseSubjectGovernment(world: WorldState, overlordId: NationId, subjectId: NationId): boolean {
  if (getSubjectOverlord(world, subjectId) !== overlordId) return false;
  endSubjectGovernment(world, overlordId, subjectId);
  return true;
}

function endSubjectGovernment(world: WorldState, overlordId: NationId, subjectId: NationId): void {
  const subject = world.nations.find((nation) => nation.id === subjectId)!;
  delete subject.subjectGovernment;
  getMilitaryAccessState(world).version++;
  if (!findWar(world.wars, overlordId, subjectId)) {
    withdrawMilitaryVisitors(world, overlordId, subjectId);
    withdrawMilitaryVisitors(world, subjectId, overlordId);
  }
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [overlordId, subjectId],
    message: `${subjectId} is no longer a subject of ${overlordId}.` });
}

export function updateSubjectGovernments(world: WorldState): void {
  for (const nation of world.nations) {
    if (nation.subjectGovernment && !getSubjectOverlord(world, nation.id)) {
      endSubjectGovernment(world, nation.subjectGovernment.overlordId, nation.id);
    }
  }
}
