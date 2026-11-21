import { clamp } from "../utils/math";
import type { MesoRegionId } from "../worldgen/meso-region";
import { relationKey } from "./diplomacy";
import { regionalConcession } from "./identity-policy";
import { grievanceLevel, prepareIdentityEffects } from "./identity-grievances";
import { getNationSupplyAssessment, isNationRegionSupplied } from "./supply-assessment";
import { getNationCharacter } from "./nation-character";
import type { NationRuntime } from "./nation-runtime";
import type { WorldState } from "./world-state";
import type { PeaceBorderContext } from "./peace-borders";
import { getMesoById } from "./world-cache";

export const MIN_DELEGATION_ADVANTAGE = 0.12;

export interface Administration {
  nation: NationRuntime;
  districts: number;
  population: number;
  strength: number;
  effects?: ReturnType<typeof prepareIdentityEffects>;
}

function localExclusion(world: WorldState, id: MesoRegionId, admin: Administration) {
  const population = world.regionalPopulations?.get(id);
  if (!population?.size || !admin.effects) return 0;
  const pact = regionalConcession(world, id, admin.nation.id);
  let exclusion = 0;
  for (const { dimension, groups } of admin.effects.dimensions) {
    for (const [group, { cost, treatment }] of groups.entries()) {
      if (pact?.dimension === dimension && (pact.group === group ||
        (pact.offer === "autonomous" && treatment === "assimilation" && cost < 1))) continue;
      exclusion += cost * population[dimension][group]! / population.size;
    }
  }
  return exclusion / admin.effects.dimensions.length;
}

export function assessRedistribution(world: WorldState, borders: PeaceBorderContext, ids: MesoRegionId[],
  overlord: Administration, subject: Administration) {
  const regions = getMesoById(world), government = subject.nation.subjectGovernment!;
  const relation = world.diplomacy?.relations.get(relationKey(overlord.nation.id, subject.nation.id));
  const trust = (relation?.trust ?? 40) / 100, pressure = (government.autonomy ?? 0) / 100;
  const local = getNationCharacter(world, subject.nation.id), central = getNationCharacter(world, overlord.nation.id);
  const parcel = new Set(ids);
  const supply = world.supplyAssessment;
  const knownSupply = supply.territoryVersion === world.territoryVersion && supply.occupationVersion === world.occupation.version
    && getNationSupplyAssessment(world, subject.nation.id);
  let suppliedAccess = false;
  let population = 0, weight = 0, localGrievance = 0, centralExclusion = 0, subjectExclusion = 0;
  let assets = 0, food = 0, hostile = 0, subjectEdges = 0, centralEdges = 0;
  for (const id of ids) {
    const region = regions.get(id)!;
    const residents = world.regionalPopulations?.get(id)?.size ?? 1;
    const exposureWeight = Math.max(0.001, residents);
    population += residents;
    weight += exposureWeight;
    localGrievance += grievanceLevel(world.identityGrievances?.get(id)) * exposureWeight;
    centralExclusion += localExclusion(world, id, overlord) * exposureWeight;
    subjectExclusion += localExclusion(world, id, subject) * exposureWeight;
    assets += (region.building === "city" ? 1.1 : region.building === "port" ? 0.45 : 0) + (region.resource ? 0.75 : 0);
    food += (world.agriculturalLand?.get(id)?.harvest ?? 0) + Number(world.irrigatedDistricts?.has(id) ?? false) * 0.22;
    for (const next of borders.neighbors.get(id) ?? []) {
      if (parcel.has(next)) continue;
      const owner = borders.before.get(next);
      if (owner === subject.nation.id) {
        subjectEdges++;
        if (knownSupply && !suppliedAccess && !world.occupation.mesoById.has(next)) {
          suppliedAccess = isNationRegionSupplied(world, subject.nation.id, next);
        }
      }
      else if (owner === overlord.nation.id) centralEdges++;
      else if (owner) {
        const neighbor = world.diplomacy?.relations.get(relationKey(subject.nation.id, owner));
        hostile += Math.max(0, -(neighbor?.opinion ?? 0) / 100) + (neighbor?.crisis ? 0.5 : 0);
      }
    }
  }
  const legitimacy = (subject.nation.identityStability?.legitimacy ?? 100) / 100;
  const nationalGrievance = subject.nation.identityStability?.grievance ?? 0;
  const burden = Math.max(ids.length / subject.districts, population / Math.max(1, subject.population));
  const capacity = 0.55 + legitimacy * 0.45 + local.innovation * 0.4 - nationalGrievance * 0.55;
  const fit = (centralExclusion - subjectExclusion) / weight;
  const topology = (subjectEdges - centralEdges) / Math.max(1, subjectEdges + centralEdges);
  const industry = assets / ids.length;
  const agriculture = food / ids.length;
  const shortage = 1 - (subject.nation.food?.rationCoverage ?? 1);
  const borderRisk = Math.min(1, hostile / ids.length + (knownSupply && !suppliedAccess ? 0.35 : 0));
  const protection = clamp(overlord.strength / Math.max(1, overlord.strength + subject.strength), 0, 1);
  const dependence = protection * trust * clamp(overlord.nation.warCooperation, 0, 1);
  const newFootprint = (subject.districts + ids.length) / Math.max(1, overlord.districts - ids.length);
  const independenceRisk = Math.min(1.5, newFootprint) *
    Math.max(0, pressure * 0.75 + (1 - trust) * 0.45 + (1 - protection) * 0.18 - dependence * 0.36);
  const localCost = subjectExclusion / weight * 0.9 + localGrievance / weight * 0.35 +
    nationalGrievance * 0.53 + burden / Math.max(0.2, capacity) * 0.51 + borderRisk * (0.30 - dependence * 0.12);
  const localBenefit = 0.15 + industry * 0.43 + agriculture * (0.18 + shortage * 0.25) +
    Math.min(0.2, population / Math.max(1, subject.population) * 0.32) + local.cooperation * trust * 0.16 +
    topology * 0.13 + dependence * 0.07 - (government.foodLevy ?? 0) * 0.06;
  const valueOfDirectRule = industry * (0.42 + central.thrift * 0.13) +
    agriculture * (0.11 + (1 - (overlord.nation.food?.rationCoverage ?? 1)) * 0.26);
  const score = fit * 1.7 + topology * 0.44 + trust * central.cooperation * 0.32 +
    (overlord.nation.identityStability?.grievance ?? 0) * 0.28 -
    valueOfDirectRule - localCost * 0.32 - borderRisk * (0.12 + protection * 0.10) - independenceRisk * 0.73;
  const willing = localBenefit - localCost;
  const canImpose = !government.selfGovernment && pressure < 0.35 && protection >= 0.62 && trust >= 0.45 && willing >= -0.25;
  const capacityExceeded = burden > capacity;
  const delegationReason = fit > 0.075 ? "lower institutional exclusion under the subject" :
    topology > 0.10 ? "a longer land border with the subject" : "the balance of administration, defense and bilateral trust";
  const retentionReason = capacityExceeded ? "The subject could not administer the additional population and districts." :
    independenceRisk * 0.73 >= Math.max(0.20, valueOfDirectRule) ? "Direct rule limited the subject's independent leverage." :
    valueOfDirectRule >= 0.24 ? "The overlord prioritized direct control of production and strategic assets." :
    topology < -0.20 ? "The district had a longer land border with the overlord." :
    borderRisk >= 0.35 ? "The subject would face additional security or supply risks." :
    "Delegation offered too little advantage over direct administration.";
  return { score, willing, canImpose, capacityExceeded, delegationReason, retentionReason };
}
