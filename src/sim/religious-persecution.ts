import { getDomesticUnrest } from "./domestic-unrest";
import { getActiveFaithBan, getEffectiveTreatment, getRecognizedFaith, regionalConcession } from "./identity-policy";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { addPersecutionImpact, createPersecutionImpact, publishPersecutionImpact } from "./persecution-reaction";
import { POPULATION_GROUPS, type RegionalPopulation } from "./regional-population";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function getReligiousBan(world: WorldState, nation: NationRuntime): NationRuntime["religiousBan"] {
  return getActiveFaithBan(world, nation);
}

export function startReligiousBan(world: WorldState, nation: NationRuntime): boolean {
  const faith = getRecognizedFaith(nation), now = world.time.slowTick;
  if (!hasPoliticalTurbulence(world) || faith === undefined || !isNationActive(nation) ||
    nation.religiousBan || (nation.nextReligiousBanAt ?? 0) > now || !POPULATION_GROUPS.faith[faith]) return false;
  nation.religiousBan = { allowedFaith: faith, until: now + 150 };
  nation.nextReligiousBanAt = now + 450;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} restricted unprotected religions outside the state faith, ${POPULATION_GROUPS.faith[faith]}.` });
  return true;
}

export function endReligiousBan(world: WorldState, nation: NationRuntime): boolean {
  if (!nation.religiousBan) return false;
  delete nation.religiousBan;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} lifted its ban on other religions.` });
  return true;
}

export function updateReligiousPersecution(world: WorldState): void {
  const now = world.time.slowTick, populations = world.regionalPopulations;
  if (now % 10 !== 0 || !populations) return;
  const active = new Map<NationRuntime["id"], { nation: NationRuntime; impact: RegionalPopulation; population: number }>();
  for (const nation of world.nations) {
    if (nation.religiousBan && (!isNationActive(nation) || !getReligiousBan(world, nation))) endReligiousBan(world, nation);
    if (!nation.displacementOrder && nation.politics?.system === "monarchy" && nation.populationPolicy?.type === "religious" &&
      (world.domesticUnrest?.byNationId.get(nation.id)?.pressure ?? 0) >= 65 &&
      getNationCharacter(world, nation.id).aggression >= 0.75) startReligiousBan(world, nation);
    const ban = getReligiousBan(world, nation);
    if (!ban || ban.lastAppliedAt === now) continue;
    ban.lastAppliedAt = now;
    active.set(nation.id, { nation, impact: createPersecutionImpact(), population: 0 });
  }
  if (!active.size) return;
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const entry = active.get(owner), population = populations.get(id), occupier = world.occupation.mesoById.get(id);
    if (!entry || !population?.size || (occupier && occupier !== owner)) continue;
    entry.population += population.size;
    const pact = regionalConcession(world, id, owner);
    for (const [group, count] of population.faith.entries()) {
      if (group !== entry.nation.religiousBan!.allowedFaith && count > 0 &&
          !(pact?.dimension === "faith" && pact.group === group) &&
          getEffectiveTreatment(world, entry.nation, "faith", group) === "restricted") {
        addPersecutionImpact(entry.impact, population, "faith", group, count * 0.06);
      }
    }
  }
  for (const { nation, impact, population } of active.values()) {
    if (!population || !impact.size) continue;
    const unrest = getDomesticUnrest(world, nation.id);
    unrest.pressure = Math.min(100, unrest.pressure + 6 + 12 * impact.size / (population * 0.06));
    publishPersecutionImpact(world, nation.id, impact, "religious persecution");
  }
}
