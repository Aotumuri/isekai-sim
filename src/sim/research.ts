import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import { isNationRegionSupplied } from "./supply-assessment";
import { recordSimulationEvent } from "./simulation-settings";
import { getCityTargetsByNation } from "./world-cache";
import type { WorldState } from "./world-state";

export const RESEARCH_BRANCHES = ["firepower", "reliability", "materials", "fuel", "logistics", "production"] as const;
export type ResearchBranch = typeof RESEARCH_BRANCHES[number];
export type ResearchLevels = Record<ResearchBranch, number>;
export interface ResearchPortfolio {
  levels: ResearchLevels;
  progress: ResearchLevels;
  focus: ResearchBranch | "auto";
  investment: "economy" | "balanced" | "ambitious";
  primaryBranch: ResearchBranch;
  status: "researching" | "saving resources" | "capital isolated" | "complete" | "paused";
  lastScience: number;
  totalScience: number;
  completedProjects: number;
}
export interface ResearchState {
  byNationId: Map<NationId, ResearchPortfolio>;
  lastSlowTick: number;
  lastRetrofitSlowTick: number;
  weaponsSpent: number;
  steelSpent: number;
  retrofits: number;
  licensesShared: number;
  lastLicenseSlowTick: number;
  licenseCooldowns: Map<string, number>;
}
export interface WeaponDesign {
  manufacturerId: NationId;
  levels: ResearchLevels;
  generation: number;
  firepower: number;
  reliability: number;
  weaponCost: number;
  steelCost: number;
  fuelUse: number;
  recovery: number;
}
export function emptyResearchLevels(): ResearchLevels {
  return { firepower: 0, reliability: 0, materials: 0, fuel: 0, logistics: 0, production: 0 };
}
export function getResearchState(world: WorldState): ResearchState {
  return world.research ??= { byNationId: new Map(), lastSlowTick: -1, lastRetrofitSlowTick: -10, weaponsSpent: 0,
    steelSpent: 0, retrofits: 0, licensesShared: 0, lastLicenseSlowTick: -60, licenseCooldowns: new Map() };
}
export function getResearchPortfolio(world: WorldState, nationId: NationId): ResearchPortfolio {
  const state = getResearchState(world);
  let portfolio = state.byNationId.get(nationId);
  if (!portfolio) {
    portfolio = { levels: emptyResearchLevels(), progress: emptyResearchLevels(), focus: "auto",
      investment: "balanced", primaryBranch: "firepower", status: "paused", lastScience: 0, totalScience: 0, completedProjects: 0 };
    state.byNationId.set(nationId, portfolio);
  }
  return portfolio;
}
export function getResearchCost(portfolio: ResearchPortfolio, branch: ResearchBranch): number {
  return 70 + portfolio.levels[branch] * 45 + RESEARCH_BRANCHES.reduce((sum, key) => sum + portfolio.levels[key], 0) * 3;
}

/** More power is heavier, more expensive and initially less reliable. */
export function designFromResearch(manufacturerId: NationId, levels: ResearchLevels): WeaponDesign {
  const safe = Object.fromEntries(RESEARCH_BRANCHES.map((branch) => [branch, clamp(Number.isFinite(levels[branch]) ? levels[branch] : 0, 0, 10)])) as ResearchLevels;
  return { manufacturerId, levels: { ...safe }, generation: RESEARCH_BRANCHES.reduce((sum, branch) => sum + safe[branch], 0),
    firepower: 1 + safe.firepower * 0.06,
    reliability: clamp(1 + safe.reliability * 0.025 - safe.firepower * 0.015, 0.8, 1.25),
    weaponCost: clamp(1 + safe.firepower * 0.06 + safe.reliability * 0.02 - safe.materials * 0.045 - safe.production * 0.025, 0.55, 1.8),
    steelCost: clamp(1 + safe.firepower * 0.08 - safe.materials * 0.045 - safe.production * 0.02, 0.55, 1.9),
    fuelUse: clamp(1 + safe.firepower * 0.04 - safe.fuel * 0.045 - safe.logistics * 0.015, 0.5, 1.5),
    recovery: 1 + safe.logistics * 0.03 };
}
export function getNationalDesign(world: WorldState, nationId: NationId): WeaponDesign {
  return designFromResearch(nationId, world.research?.byNationId.get(nationId)?.levels ?? emptyResearchLevels());
}

export function getResearchPriorities(world: WorldState, nationId: NationId): ResearchLevels {
  const character = getNationCharacter(world, nationId);
  const weights: ResearchLevels = { firepower: 1, reliability: 1, materials: 1, fuel: 1, logistics: 1, production: 1 };
  const preferred: Record<typeof character.doctrine, ResearchBranch[]> = {
    expansionist: ["firepower", "firepower", "reliability"], merchant: ["materials", "production", "production"],
    technocrat: ["firepower", "reliability", "logistics"], guardian: ["reliability", "logistics", "reliability"],
    pragmatist: ["materials", "fuel", "production"], isolationist: ["reliability", "materials", "fuel"],
  };
  for (const branch of preferred[character.doctrine]) weights[branch] += 1.5;
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation && nation.resources.steel < 30) weights.materials += 2;
  if (nation && nation.resourceFlow.delta.fuel < 0) weights.fuel += 3;
  if (world.wars.some((war) => war.nationAId === nationId || war.nationBId === nationId)) {
    weights.firepower += 1.5; weights.reliability += 1;
  }
  const portfolio = getResearchPortfolio(world, nationId);
  if (portfolio.focus !== "auto") weights[portfolio.focus] += 8;
  for (const branch of RESEARCH_BRANCHES) if (portfolio.levels[branch] >= 10) weights[branch] = 0;
  return weights;
}

export function updateResearch(world: WorldState): void {
  if (!world.settings?.researchEnabled) return;
  const state = getResearchState(world);
  if (state.lastSlowTick === world.time.slowTick) return;
  state.lastSlowTick = world.time.slowTick;
  const active = new Set(world.nations.filter(isNationActive).map((nation) => nation.id));
  for (const id of state.byNationId.keys()) if (!active.has(id)) state.byNationId.delete(id);
  const cities = getCityTargetsByNation(world);
  for (const nation of world.nations.filter(isNationActive)) {
    const portfolio = getResearchPortfolio(world, nation.id);
    portfolio.lastScience = 0;
    if (!isNationRegionSupplied(world, nation.id, nation.capitalMesoId)) { portfolio.status = "capital isolated"; continue; }
    const priorities = getResearchPriorities(world, nation.id);
    const total = RESEARCH_BRANCHES.reduce((sum, branch) => sum + priorities[branch], 0);
    if (total === 0) { portfolio.status = "complete"; continue; }
    portfolio.primaryBranch = [...RESEARCH_BRANCHES].sort((a, b) => priorities[b] - priorities[a])[0]!;
    const investment = portfolio.investment === "ambitious" ? 1.5 : portfolio.investment === "economy" ? 0.5 : 1;
    const capacity = Math.min(3, 0.6 + (cities.get(nation.id)?.length ?? 0) * 0.12 + getNationCharacter(world, nation.id).innovation * 0.5) * investment;
    const budget = Math.min(capacity, Math.max(0, nation.resources.steel - 6) / 0.4, Math.max(0, nation.resources.weapons - 6) / 0.2);
    if (budget < 0.1) { portfolio.status = "saving resources"; continue; }
    const steel = budget * 0.4, weapons = budget * 0.2;
    nation.resources.steel -= steel; nation.resources.weapons -= weapons;
    nation.resourceFlow.usage.steel += steel; nation.resourceFlow.delta.steel -= steel;
    nation.resourceFlow.usage.weapons += weapons; nation.resourceFlow.delta.weapons -= weapons;
    state.steelSpent += steel; state.weaponsSpent += weapons;
    portfolio.lastScience = budget; portfolio.totalScience += budget; portfolio.status = "researching";
    for (const branch of RESEARCH_BRANCHES) {
      if (priorities[branch] === 0) continue;
      portfolio.progress[branch] += budget * priorities[branch] / total;
      const cost = getResearchCost(portfolio, branch);
      if (portfolio.progress[branch] + 1e-9 < cost) continue;
      portfolio.progress[branch] -= cost; portfolio.levels[branch] += 1; portfolio.completedProjects += 1;
      recordSimulationEvent(world, { category: "research", nationIds: [nation.id],
        message: `${nation.id} completed ${branch} level ${portfolio.levels[branch]}.` });
    }
  }
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
