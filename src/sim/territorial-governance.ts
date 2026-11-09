import type { NationId } from "../worldgen/nation";
import { recordAnnexation } from "./annexation";
import { getRelation } from "./diplomacy";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { dominantGroup, POPULATION_DIMENSIONS, type RegionalPopulation } from "./regional-population";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getSubjectOverlord } from "./subject-governments";
import { transferTerritories } from "./territory-transfer";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export type GovernancePolicy = NonNullable<NationRuntime["governance"]>["policy"];

function changePolicy(world: WorldState, nation: NationRuntime, policy: GovernancePolicy, manual: boolean): void {
  const state = nation.governance ??= { policy: "centralized", stability: 100, diversity: 0, alignment: 1, since: world.time.slowTick };
  if (manual) state.manual = true;
  if (state.policy === policy) return;
  state.policy = policy;
  state.since = world.time.slowTick;
  state.alignment = 0;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} adopted ${policy === "autonomy" ? "regional autonomy" : policy === "assimilation" ? "cultural and religious assimilation" : "centralized administration"}.` });
}

export function setGovernancePolicy(world: WorldState, actor: NationId, target: NationId, policy: GovernancePolicy): boolean {
  const nation = world.nations.find(({ id }) => id === target);
  if (!hasPoliticalTurbulence(world) || !nation || !isNationActive(nation) ||
    (actor !== target && getSubjectOverlord(world, target) !== actor)) return false;
  changePolicy(world, nation, policy, true);
  return true;
}

export function getGovernanceUnrest(nation: NationRuntime): number {
  const state = nation.governance;
  if (!state) return 0;
  return Math.max(0, 65 - state.stability) * 0.024 +
    (state.policy === "assimilation" ? (1 - state.alignment) * 1.35 : 0);
}

export function getSubjectIntegrationIssue(world: WorldState, overlord: NationId, subject: NationId): string | undefined {
  if (!hasPoliticalTurbulence(world) || getSubjectOverlord(world, subject) !== overlord) return "An active subject government is required.";
  const nation = world.nations.find(({ id }) => id === subject)!;
  const state = nation.governance;
  if (state?.policy !== "assimilation" || world.time.slowTick - state.since < 180 || state.alignment < 0.72) return "Assimilation must run for 180s and reach 72% alignment.";
  if (state.stability < 55 || (nation.subjectGovernment?.autonomy ?? 0) > 65 ||
    getRelation(world, overlord, subject).trust < 45) return "Requires stability 55, autonomy pressure at most 65, and trust 45.";
  if (world.wars.some(({ nationAId, nationBId }) => [nationAId, nationBId].some((id) => id === overlord || id === subject))) return "Both governments must be at peace.";
  if (world.volunteers?.missions.some((mission) => (mission.donorId === subject || mission.recipientId === subject) &&
    !["completed", "lost", "integrated"].includes(mission.status))) return "The subject has volunteer units in transit or on duty.";
  if (world.macroRegions.some((macro) => macro.nationId === subject && macro.mesoRegionIds.some((id) => {
    const occupier = world.occupation.mesoById.get(id);
    return occupier && occupier !== subject;
  }))) return "The subject must control its territory.";
}

export function integrateSubjectGovernment(world: WorldState, overlord: NationId, subject: NationId): boolean {
  if (getSubjectIntegrationIssue(world, overlord, subject)) return false;
  const nation = world.nations.find(({ id }) => id === subject)!;
  const sponsor = world.nations.find(({ id }) => id === overlord)!;
  const districts = world.macroRegions.filter(({ nationId }) => nationId === subject).flatMap(({ mesoRegionIds }) => mesoRegionIds);
  if (!transferTerritories(world, [{ from: subject, to: overlord, regionIds: districts }], "integration")) return false;
  delete nation.subjectGovernment;
  if (world.militaryAccess) world.militaryAccess.version++;
  for (const resource of ["steel", "fuel", "manpower", "weapons"] as const) {
    sponsor.resources[resource] += nation.resources[resource];
    nation.resources[resource] = 0;
  }
  if (sponsor.treasury && nation.treasury) {
    sponsor.treasury.balance += nation.treasury.balance;
    nation.treasury.balance = 0;
  }
  if (sponsor.food && nation.food) {
    sponsor.food.stock += nation.food.stock;
    nation.food.stock = 0;
  }
  recordAnnexation(world, overlord, districts);
  recordSimulationEvent(world, { category: "politics", nationIds: [overlord, subject],
    message: `${overlord} integrated ${subject} after a period of assimilation.` });
  return true;
}

export function updateTerritorialGovernance(world: WorldState): void {
  const now = world.time.slowTick, populations = world.regionalPopulations;
  if (!hasPoliticalTurbulence(world) || now % 10 !== 0 || !populations) return;
  const districts = new Map<NationId, RegionalPopulation[]>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = populations.get(id), occupier = world.occupation.mesoById.get(id);
    if (!population?.size || (occupier && occupier !== owner)) continue;
    const entries = districts.get(owner) ?? [];
    entries.push(population);
    districts.set(owner, entries);
  }
  let changed = false;
  for (const nation of world.nations) {
    if (!isNationActive(nation)) continue;
    const owned = districts.get(nation.id), capital = populations.get(nation.capitalMesoId);
    if (!owned?.length || !capital) continue;
    const state = nation.governance ??= { policy: "centralized", stability: 100, diversity: 0, alignment: 1, since: now };
    const overlord = getSubjectOverlord(world, nation.id);
    const sponsor = overlord && world.nations.find(({ id }) => id === overlord);
    const sponsorCapital = sponsor ? populations.get(sponsor.capitalMesoId) : undefined;
    const total = owned.reduce((sum, population) => sum + population.size, 0);
    state.diversity = POPULATION_DIMENSIONS.reduce((sum, dimension) => {
      const group = dominantGroup(capital[dimension]);
      return sum + 1 - owned.reduce((amount, population) => amount + population[dimension][group]!, 0) / total;
    }, 0) / POPULATION_DIMENSIONS.length;
    if (!state.manual && state.policy === "centralized" && now >= 120) {
      if (sponsor && getNationCharacter(world, sponsor.id).aggression >= 0.6 && (nation.subjectGovernment?.autonomy ?? 0) < 55) {
        changePolicy(world, nation, "assimilation", false);
      } else if (state.diversity > 0.3 && getNationCharacter(world, nation.id).cooperation >= 0.55) {
        changePolicy(world, nation, "autonomy", false);
      }
    }
    const reference = sponsorCapital ?? capital;
    const dimensions = ["culture", "faith"] as const;
    let alignment = 0;
    for (const dimension of dimensions) {
      const group = dominantGroup(reference[dimension]);
      for (const population of owned) {
        const distribution = population[dimension];
        if (state.policy === "assimilation" && distribution[group]! < population.size - 1e-8) {
          let moved = 0;
          for (const [index, count] of distribution.entries()) {
            if (index === group) continue;
            distribution[index] = count * 0.965;
            moved += count - distribution[index]!;
          }
          distribution[group]! += moved;
          changed ||= moved > 0;
        }
        alignment += distribution[group]!;
      }
    }
    state.alignment = alignment / (total * dimensions.length);
    const diversityCost = state.diversity * (state.policy === "autonomy" ? 30 : 85);
    const resistance = state.policy === "assimilation" ? (1 - state.alignment) * 35 : 0;
    const target = Math.max(0, 100 - diversityCost - resistance);
    state.stability += (target - state.stability) * 0.25;
    if (sponsor && state.policy === "assimilation" && !state.manual && state.alignment >= 0.82) {
      integrateSubjectGovernment(world, sponsor.id, nation.id);
    }
  }
  if (changed) world.populationRevision = (world.populationRevision ?? 0) + 1;
}
