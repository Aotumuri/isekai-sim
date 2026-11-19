import assert from "node:assert/strict";
import { isNationActive } from "../../src/sim/nation-active";
import { POPULATION_DIMENSIONS, POPULATION_GROUPS } from "../../src/sim/regional-population";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";

const resources = ["steel", "fuel", "weapons", "manpower", "copper", "rubber", "tungsten"] as const;
const emptyStocks = () => ({ steel: 0, fuel: 0, weapons: 0, manpower: 0, copper: 0, rubber: 0, tungsten: 0 });
export const createFlowTotals = () => ({ income: emptyStocks(), usage: emptyStocks(), surplus: emptyStocks() });

export function sampleFlows(world: WorldState, totals: ReturnType<typeof createFlowTotals>): void {
  for (const { resourceFlow: flow } of world.nations) {
    if (flow.lastTick !== world.time.slowTick) continue;
    for (const key of resources) {
      totals.income[key] += flow.income[key] ?? 0;
      totals.usage[key] += flow.usage[key] ?? 0;
      totals.surplus[key] += flow.productionSurplus?.[key] ?? 0;
    }
  }
}

export function summarizeWorld(world: WorldState) {
  const owners = getOwnerByMesoId(world);
  const land = new Map<string, number>();
  for (const owner of owners.values()) land.set(owner, (land.get(owner) ?? 0) + 1);
  const landTotal = [...land.values()].reduce((sum, districts) => sum + districts, 0);
  const populationGroups = POPULATION_DIMENSIONS.map((dimension) =>
    POPULATION_GROUPS[dimension].map(() => 0));
  const nationPopulation = new Map<string, number>();
  let population = 0, localMix = 0;
  for (const [district, region] of world.regionalPopulations ?? []) {
    population += region.size;
    const owner = owners.get(district);
    if (owner) nationPopulation.set(owner, (nationPopulation.get(owner) ?? 0) + region.size);
    POPULATION_DIMENSIONS.forEach((dimension, i) => {
      const distribution = region[dimension];
      assert(distribution.every((count) => Number.isFinite(count) && count >= -1e-8));
      assert(Math.abs(distribution.reduce((a, b) => a + b, 0) - region.size) < 1e-6);
      distribution.forEach((count, j) => { populationGroups[i]![j]! += count; });
      localMix += region.size - Math.max(...distribution);
    });
  }
  const treaties: Record<string, number> = {};
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    for (const { type, expiresAtSlowTick } of relation.treaties) {
      if (expiresAtSlowTick > world.time.slowTick) treaties[type] = (treaties[type] ?? 0) + 1;
    }
  }
  for (const nation of world.nations) {
    for (const value of Object.values(nation.resources)) assert(Number.isFinite(value) && value >= -1e-8);
    assert(!nation.treasury || (Number.isFinite(nation.treasury.balance) && nation.treasury.balance >= 0));
  }
  const active = world.nations.filter(isNationActive).map((nation) => {
    const root = world.research?.byNationId.get(nation.id);
    const programs = root ? [root, ...Object.values(root.programs ?? {})] : [];
    for (const program of programs) {
      assert(Object.values(program.levels).every((level) => Number.isSafeInteger(level) && level >= 0));
      assert(Object.values(program.progress).every((value) => Number.isFinite(value) && value >= 0));
    }
    return { id: nation.id, land: land.get(nation.id) ?? 0, population: nationPopulation.get(nation.id) ?? 0,
      subject: nation.subjectGovernment, governance: nation.governance, ideology: nation.politics?.governingIdeologyId,
      unrest: world.domesticUnrest?.byNationId.get(nation.id), stocks: nation.resources, flow: nation.resourceFlow,
      treasury: nation.treasury?.balance, food: nation.food?.stock, projects: programs.reduce((n, p) => n + p.completedProjects, 0),
      levels: programs.map((p) => Math.max(...Object.values(p.levels))), statuses: programs.map((p) => p.status),
    };
  });
  const trade = world.internationalTrade;
  return {
    active: active.length, total: world.nations.length,
    maxShare: Math.max(0, ...land.values()) / Math.max(1, landTotal),
    hhi: [...land.values()].reduce((sum, count) => sum + (count / landTotal) ** 2, 0),
    population, populationGroups, localMix: localMix / Math.max(1, population * POPULATION_DIMENSIONS.length),
    wars: world.wars.length, treaties, relations: world.diplomacy?.relations.size ?? 0,
    peace: world.diplomacy?.peaceAgreements ?? 0,
    defensiveInterventions: world.diplomacy?.defensiveInterventions ?? 0,
    trade: { delivered: trade?.delivered ?? 0, returned: trade?.returned ?? 0, fuelSpent: trade?.fuelSpent ?? 0 },
    coalitions: world.commonThreatCoalitions.coalitions.length,
    coalitionsFormed: world.commonThreatCoalitions.coalitionsFormed,
    coalitionsDissolved: world.commonThreatCoalitions.coalitionsDissolved,
    units: world.units.length, strength: world.units.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0),
    researchSteel: world.research?.steelSpent ?? 0, researchWeapons: world.research?.weaponsSpent ?? 0,
    licenses: world.research?.licensesShared ?? 0, refits: world.research?.retrofits ?? 0, nations: active,
  };
}
