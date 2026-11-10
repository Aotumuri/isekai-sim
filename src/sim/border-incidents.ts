import { getRelation, hasTreaty, relationKey } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { getNationCharacter } from "./nation-character";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { areSubjectPartners } from "./subject-governments";
import { buildWarAdjacency, isAtWar, normalizeWarPair } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export function updateBorderIncidents(world: WorldState): void {
  const now = world.time.slowTick;
  if (!hasPoliticalTurbulence(world) || now < 90 || now % 15 !== 0) return;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const deployments = new Map<string, { a: NationId; b: NationId; first: number; second: number }>();
  for (const unit of world.units) {
    if (unit.domain !== "land" || unit.org < 0.25 || unit.manpower <= 0 || owners.get(unit.regionId) !== unit.nationId) continue;
    const neighbors = new Set((regions.get(unit.regionId)?.neighbors ?? []).map(({ id }) => owners.get(id)));
    for (const other of neighbors) {
      if (!other || other === unit.nationId) continue;
      const key = relationKey(unit.nationId, other);
      const [a, b] = normalizeWarPair(unit.nationId, other);
      const entry = deployments.get(key) ?? { a, b, first: 0, second: 0 };
      if (unit.nationId === a) entry.first++;
      else entry.second++;
      deployments.set(key, entry);
    }
  }
  const wars = buildWarAdjacency(world.wars);
  for (const { a, b, first, second } of deployments.values()) {
    if (!first || !second || isAtWar(a, b, wars) || areFactionPartners(world, a, b) ||
      areSubjectPartners(world, a, b) || hasTreaty(world, a, b, "alliance") || hasTreaty(world, a, b, "truce")) continue;
    const relation = getRelation(world, a, b);
    if (relation.crisis || (relation.nextBorderIncidentAt ?? 0) > now || relation.opinion >= 35) continue;
    const aggression = Math.max(getNationCharacter(world, a).aggression, getNationCharacter(world, b).aggression);
    if (aggression < 0.6 && relation.tension < 30) continue;
    relation.nextBorderIncidentAt = now + 150;
    relation.tension = Math.min(100, relation.tension + (first + second >= 4 ? 32 : 22));
    relation.grievance = Math.min(100, relation.grievance + 13);
    relation.opinion = Math.max(-100, relation.opinion - 12);
    recordSimulationEvent(world, { category: "military", nationIds: [a, b],
      message: `${a}と${b}の部隊が国境で対峙し、外交上の緊張が高まりました。` });
  }
}
