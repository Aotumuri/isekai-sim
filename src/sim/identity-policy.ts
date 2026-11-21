import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { hasPoliticalTurbulence } from "./simulation-settings";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_GROUPS, type PopulationDimension } from "./regional-population";
import type { WorldState } from "./world-state";

// These keys are independent of the labels and the indices used by population arrays.
export const IDENTITY_GROUP_IDS = {
  ancestry: ["auvren", "veyari", "kethren", "orruvi", "nhalai", "istren"],
  culture: ["reed-courts", "tide-guilds", "spiral-gardens", "lantern-roads", "stone-circles", "wind-archives"],
  faith: ["ember-covenant", "nine-wells", "silent-orbit", "dawn-loom", "mirror-vigil", "hollow-star"],
} as const;

export type IdentityGroup<D extends PopulationDimension> = (typeof IDENTITY_GROUP_IDS)[D][number];
export type GroupTreatment = "protected" | "tolerated" | "autonomous" | "assimilation" | "restricted";
export type IdentityTreatment<D extends PopulationDimension> = D extends "ancestry"
  ? Exclude<GroupTreatment, "assimilation" | "autonomous">
  : GroupTreatment;

export interface IdentityDecision {
  day: number;
  dimension: PopulationDimension;
  group: string;
  action: GroupTreatment | "recognition";
  reason: string;
}

export interface IdentityGovernment {
  favored: { [D in PopulationDimension]: IdentityGroup<D> };
  stateReligion: boolean;
  treatments: { [D in PopulationDimension]: Partial<Record<IdentityGroup<D>, IdentityTreatment<D>>> };
  nextReviewAt: number;
  decisions: IdentityDecision[];
  decisionCount: number;
}

export function identityGroupIndex<D extends PopulationDimension>(dimension: D, id: IdentityGroup<D>): number {
  return (IDENTITY_GROUP_IDS[dimension] as readonly string[]).indexOf(id);
}

export function identityGroupName<D extends PopulationDimension>(dimension: D, id: IdentityGroup<D>): string {
  return POPULATION_GROUPS[dimension][identityGroupIndex(dimension, id)] ?? id;
}

export function getRecognizedFaith(nation: NationRuntime): number | undefined {
  const government = nation.identityGovernment;
  if (government) return government.stateReligion ? identityGroupIndex("faith", government.favored.faith) : undefined;
  return nation.populationPolicy?.type === "religious" ? nation.populationPolicy.group : undefined;
}

export function getHomelandGroup(nation: NationRuntime): number | undefined {
  if (nation.populationPolicy?.type !== "homeland") return undefined;
  return nation.identityGovernment
    ? identityGroupIndex("ancestry", nation.identityGovernment.favored.ancestry)
    : nation.populationPolicy.group;
}

export function getGroupTreatment<D extends PopulationDimension>(
  nation: NationRuntime, dimension: D, group: number,
): IdentityTreatment<D> {
  const id = IDENTITY_GROUP_IDS[dimension][group] as IdentityGroup<D>;
  return (nation.identityGovernment?.treatments[dimension][id] ?? "tolerated") as IdentityTreatment<D>;
}

export function getActiveFaithBan(world: WorldState, nation: NationRuntime): NationRuntime["religiousBan"] {
  const ban = nation.religiousBan;
  return world.settings?.politicalTurbulenceEnabled && world.settings.diplomacyEnabled && ban &&
    ban.until > world.time.slowTick && getRecognizedFaith(nation) === ban.allowedFaith ? ban : undefined;
}

export function getEffectiveTreatment<D extends PopulationDimension>(
  world: WorldState, nation: NationRuntime, dimension: D, group: number,
): GroupTreatment {
  const treatment = getGroupTreatment(nation, dimension, group);
  const ban = dimension === "faith" ? getActiveFaithBan(world, nation) : undefined;
  // Explicit guarantees survive a general ban on unprotected faiths.
  if (ban && group !== ban.allowedFaith && treatment !== "protected" && treatment !== "autonomous") return "restricted";
  return treatment;
}

export function regionalConcession(world: WorldState, id: MesoRegionId, owner: NationId) {
  const pact = world.regionalNegotiations?.get(id);
  if (pact?.owner !== owner || pact.status !== "agreed" || !hasPoliticalTurbulence(world)) return;
  const occupier = world.occupation.mesoById.get(id);
  return !occupier || occupier === owner ? pact : undefined;
}
