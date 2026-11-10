import { changeResource } from "./international-trade";
import { getPrototypeMaterialRates } from "./research-materials";
import { spendTreasury } from "./treasury";
import { buildWarAdjacency } from "./war-state";
import type { NationId } from "../worldgen/nation";
import type { UnitType } from "./unit";
import { getNationCharacter } from "./nation-character";
import { isNationActive, isNationPresent } from "./nation-active";
import { isNationRegionSupplied } from "./supply-assessment";
import { recordSimulationEvent } from "./simulation-settings";
import { getCityTargetsByNation, getPortTargetsByNation } from "./world-cache";
import type { WorldState } from "./world-state";

export const EQUIPMENT_FAMILIES = ["Infantry", "Tank", "CombatShip", "TransportShip"] as const satisfies readonly UnitType[];
export type EquipmentFamily = typeof EQUIPMENT_FAMILIES[number];
export const EQUIPMENT_FAMILY_NAMES: Record<EquipmentFamily, string> = { Infantry: "Small arms", Tank: "Tanks", CombatShip: "Warships", TransportShip: "Transport ships" };
export const RESEARCH_BRANCHES = ["firepower", "reliability", "materials", "fuel", "logistics", "production", "armor", "mobility", "handling", "capacity"] as const;
export type ResearchBranch = typeof RESEARCH_BRANCHES[number];
export type ResearchLevels = Record<ResearchBranch, number>;
export const FAMILY_RESEARCH_BRANCHES: Record<EquipmentFamily, readonly ResearchBranch[]> = {
  Infantry: ["firepower", "handling", "reliability", "materials", "logistics", "production"],
  Tank: ["firepower", "armor", "mobility", "reliability", "fuel", "materials", "logistics", "production"],
  CombatShip: ["firepower", "armor", "mobility", "reliability", "fuel", "materials", "logistics", "production"],
  TransportShip: ["capacity", "armor", "mobility", "reliability", "fuel", "materials", "logistics", "production"],
};
export const RESEARCH_BRANCH_NAMES: Record<ResearchBranch, string> = { firepower: "Firepower", reliability: "Reliability", materials: "Material efficiency", fuel: "Fuel efficiency", logistics: "Logistics", production: "Production", armor: "Protection", mobility: "Speed", handling: "Accuracy & handling", capacity: "Cargo capacity" };
export type ResearchPriority = "auto" | "paused" | "low" | "normal" | "high";
export interface ResearchPortfolio {
  levels: ResearchLevels; progress: ResearchLevels; focus: ResearchBranch | "auto";
  investment: "economy" | "balanced" | "ambitious";
  priority?: ResearchPriority;
  /** The national root is also its infantry program, preserving existing infantry research APIs. */
  programs?: Partial<Record<Exclude<EquipmentFamily, "Infantry">, ResearchPortfolio>>;
  primaryBranch: ResearchBranch;
  status: "researching" | "saving resources" | "capital isolated" | "complete" | "paused" | "government in exile";
  lastScience: number; totalScience: number; completedProjects: number;
}
export interface ResearchState {
  byNationId: Map<NationId, ResearchPortfolio>; lastSlowTick: number; lastRetrofitSlowTick: number;
  weaponsSpent: number; steelSpent: number; retrofits: number; refitAnnouncedGenerationByNationId: Map<string, number>;
  licensesShared: number; lastLicenseSlowTick: number; licenseCooldowns: Map<string, number>;
}
export interface WeaponDesign {
  family?: EquipmentFamily;
  manufacturerId: NationId; levels: ResearchLevels; generation: number;
  firepower: number; reliability: number; weaponCost: number; steelCost: number; fuelUse: number; recovery: number;
  armor?: number; mobility?: number; capacity?: number; handling?: number;
}
export function emptyResearchLevels(): ResearchLevels {
  return { firepower: 0, reliability: 0, materials: 0, fuel: 0, logistics: 0, production: 0, armor: 0, mobility: 0, handling: 0, capacity: 0 };
}
function newProgram(): ResearchPortfolio {
  return { levels: emptyResearchLevels(), progress: emptyResearchLevels(), focus: "auto", investment: "balanced", priority: "auto",
    primaryBranch: "firepower", status: "paused", lastScience: 0, totalScience: 0, completedProjects: 0 };
}
export function getResearchState(world: WorldState): ResearchState {
  return world.research ??= { byNationId: new Map(), lastSlowTick: -1, lastRetrofitSlowTick: -10, weaponsSpent: 0,
    steelSpent: 0, retrofits: 0, refitAnnouncedGenerationByNationId: new Map(), licensesShared: 0, lastLicenseSlowTick: -60, licenseCooldowns: new Map() };
}
export function getResearchPortfolio(world: WorldState, nationId: NationId, family: EquipmentFamily = "Infantry"): ResearchPortfolio {
  const state = getResearchState(world);
  let root = state.byNationId.get(nationId);
  if (!root) { root = { ...newProgram(), programs: {} }; state.byNationId.set(nationId, root); }
  // Existing unified research becomes the starting point for each applicable equipment program once.
  if (!root.programs) {
    root.programs = {};
    for (const type of EQUIPMENT_FAMILIES) if (type !== "Infantry") {
      const program = newProgram();
      for (const branch of FAMILY_RESEARCH_BRANCHES[type]) { program.levels[branch] = root.levels[branch] ?? 0; program.progress[branch] = root.progress[branch] ?? 0; }
      root.programs[type] = program;
    }
  }
  const program = family === "Infantry" ? root : root.programs[family] ??= newProgram();
  for (const branch of RESEARCH_BRANCHES) {
    program.levels[branch] ??= 0; program.progress[branch] ??= 0;
    if (!FAMILY_RESEARCH_BRANCHES[family].includes(branch)) { program.levels[branch] = 0; program.progress[branch] = 0; }
  }
  if (program.focus !== "auto" && !FAMILY_RESEARCH_BRANCHES[family].includes(program.focus)) program.focus = "auto";
  if (!FAMILY_RESEARCH_BRANCHES[family].includes(program.primaryBranch)) program.primaryBranch = FAMILY_RESEARCH_BRANCHES[family][0]!;
  return program;
}
export function getResearchCost(portfolio: ResearchPortfolio, branch: ResearchBranch): number {
  return 70 + portfolio.levels[branch] * 45 + RESEARCH_BRANCHES.reduce((sum, key) => sum + (portfolio.levels[key] ?? 0), 0) * 3;
}
/** Capacity gains shrink at every level; the level cap bounds a standard ship to 25 units instead of unbounded growth. */
export function cargoCapacityMultiplier(level: number): number { const safe = clamp(Number.isFinite(level) ? level : 0, 0, 10); return 1 + safe * 0.1 + 0.6 * (1 - Math.exp(-safe / 2)); }
export function designFromResearch(manufacturerId: NationId, levels: ResearchLevels, family: EquipmentFamily = "Infantry"): WeaponDesign {
  const safe = Object.fromEntries(RESEARCH_BRANCHES.map((branch) => [branch,
    FAMILY_RESEARCH_BRANCHES[family].includes(branch) ? clamp(Number.isFinite(levels[branch]) ? levels[branch] : 0, 0, 10) : 0])) as ResearchLevels;
  const armor = safe.armor, speed = safe.mobility, cargo = safe.capacity;
  return { manufacturerId, family, levels: { ...safe }, generation: RESEARCH_BRANCHES.reduce((sum, branch) => sum + safe[branch], 0),
    firepower: 1 + safe.firepower * 0.06, handling: 1 + safe.handling * 0.025,
    armor: 1 + armor * 0.055, mobility: clamp(1 + speed * 0.045 - armor * 0.012 - cargo * 0.008, 0.8, 1.45),
    capacity: cargoCapacityMultiplier(cargo),
    reliability: clamp(1 + safe.reliability * 0.025 - safe.firepower * 0.015 - speed * 0.008 - cargo * 0.004, 0.75, 1.25),
    weaponCost: clamp(1 + safe.firepower * 0.06 + safe.reliability * 0.02 + armor * 0.04 + speed * 0.025 + cargo * 0.04 + safe.handling * 0.02 - safe.materials * 0.045 - safe.production * 0.025, 0.55, 2.8),
    steelCost: clamp(1 + safe.firepower * 0.08 + armor * 0.06 + cargo * 0.04 - safe.materials * 0.045 - safe.production * 0.02, 0.55, 2.8),
    fuelUse: clamp(1 + safe.firepower * 0.04 + armor * 0.035 + speed * 0.04 + cargo * 0.025 - safe.fuel * 0.045 - safe.logistics * 0.015, 0.5, 2),
    recovery: 1 + safe.logistics * 0.03 + safe.handling * 0.01 };
}
export function getNationalDesign(world: WorldState, nationId: NationId, family: EquipmentFamily = "Infantry"): WeaponDesign {
  if (!world.research?.byNationId.has(nationId)) return designFromResearch(nationId, emptyResearchLevels(), family);
  return designFromResearch(nationId, getResearchPortfolio(world, nationId, family).levels, family);
}
export function getResearchPriorities(world: WorldState, nationId: NationId, family: EquipmentFamily = "Infantry"): ResearchLevels {
  const character = getNationCharacter(world, nationId), weights = emptyResearchLevels();
  for (const branch of FAMILY_RESEARCH_BRANCHES[family]) weights[branch] = 1;
  const preferred: Record<typeof character.doctrine, ResearchBranch[]> = {
    expansionist: ["firepower", "mobility", "handling"], merchant: ["materials", "production", "capacity"],
    technocrat: ["firepower", "reliability", "logistics"], guardian: ["armor", "reliability", "handling"],
    pragmatist: ["materials", "fuel", "production"], isolationist: ["reliability", "armor", "materials"],
  };
  for (const branch of preferred[character.doctrine]) if (weights[branch]) weights[branch] += 1.5;
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation && nation.resources.steel < 30) weights.materials += 2;
  if (nation && nation.resourceFlow.delta.fuel < 0 && weights.fuel) weights.fuel += 3;
  if (world.wars.some((war) => war.nationAId === nationId || war.nationBId === nationId)) {
    if (weights.firepower) weights.firepower += 1.5; weights.reliability += 1;
  }
  const portfolio = getResearchPortfolio(world, nationId, family);
  if (portfolio.focus !== "auto" && weights[portfolio.focus]) weights[portfolio.focus] += 8;
  for (const branch of RESEARCH_BRANCHES) if (portfolio.levels[branch] >= 10) weights[branch] = 0;
  return weights;
}
export function getEquipmentResearchPriorities(world: WorldState, nationId: NationId): Record<EquipmentFamily, number> {
  const character = getNationCharacter(world, nationId), coastal = (getPortTargetsByNation(world).get(nationId)?.length ?? 0) > 0;
  const weights = { Infantry: 3, Tank: 1.5, CombatShip: coastal ? 1 : 0, TransportShip: coastal ? 0.8 : 0 };
  if (character.doctrine === "expansionist") weights.Tank += 1;
  if (character.doctrine === "guardian") weights.Infantry += 1;
  if (coastal && character.doctrine === "merchant") weights.TransportShip += 1.5;
  const enemies = buildWarAdjacency(world.wars).get(nationId);
  if (enemies?.size) {
    const observations = world.strategicThreatObservation.observationByNationId;
    const opposingShips = [...enemies].reduce((sum, id) =>
      sum + (observations.get(id)?.power.combatShips ?? 0), 0);
    const ownShips = observations.get(nationId)?.power.combatShips ?? 0;
    if (coastal && opposingShips > ownShips) {
      weights.CombatShip += Math.min(3, (opposingShips - ownShips) * 0.75);
    }
  }
  for (const family of EQUIPMENT_FAMILIES) {
    const program = getResearchPortfolio(world, nationId, family), priority = program.priority ?? "auto";
    if (priority !== "auto") weights[family] = { paused: 0, low: 0.35, normal: 1, high: 4 }[priority];
    if (!Object.values(getResearchPriorities(world, nationId, family)).some((value) => value > 0)) weights[family] = 0;
  }
  return weights;
}
export function getNationalResearchSummary(world: WorldState, nationId: NationId) {
  const programs = EQUIPMENT_FAMILIES.map((family) => getResearchPortfolio(world, nationId, family));
  return { lastScience: programs.reduce((sum, program) => sum + program.lastScience, 0), totalScience: programs.reduce((sum, program) => sum + program.totalScience, 0),
    completedProjects: programs.reduce((sum, program) => sum + program.completedProjects, 0) };
}
export function updateResearch(world: WorldState): void {
  if (!world.settings?.researchEnabled) return;
  const state = getResearchState(world);
  if (state.lastSlowTick === world.time.slowTick) return;
  state.lastSlowTick = world.time.slowTick;
  for (const id of state.byNationId.keys()) if (!world.nations.some((nation) => nation.id === id && isNationPresent(world, nation))) {
    state.byNationId.delete(id);
    for (const key of state.refitAnnouncedGenerationByNationId.keys()) if (key === id || key.startsWith(`${id}|`)) state.refitAnnouncedGenerationByNationId.delete(key);
  }
  const cities = getCityTargetsByNation(world);
  for (const nation of world.nations.filter((item) => isNationPresent(world, item))) {
    const programs = EQUIPMENT_FAMILIES.map((family) => getResearchPortfolio(world, nation.id, family));
    for (const program of programs) program.lastScience = 0;
    if (!isNationActive(nation)) { for (const program of programs) program.status = "government in exile"; continue; }
    if (!isNationRegionSupplied(world, nation.id, nation.capitalMesoId)) { for (const program of programs) program.status = "capital isolated"; continue; }
    const weights = getEquipmentResearchPriorities(world, nation.id), total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    for (const family of EQUIPMENT_FAMILIES) if (!weights[family]) {
      const program = getResearchPortfolio(world, nation.id, family);
      program.status = FAMILY_RESEARCH_BRANCHES[family].every((branch) => program.levels[branch] >= 10) ? "complete" : "paused";
    }
    if (!total) continue;
    const root = getResearchPortfolio(world, nation.id);
    const investment = root.investment === "ambitious" ? 1.5 : root.investment === "economy" ? 0.5 : 1;
    const capacity = Math.min(3, 0.6 + (cities.get(nation.id)?.length ?? 0) * 0.12 + getNationCharacter(world, nation.id).innovation * 0.5) * investment;
    const materialLimit = Math.min(Math.max(0, nation.resources.steel - 6) / 0.4, Math.max(0, nation.resources.weapons - 6) / 0.2);
    const baseBudget = Math.min(capacity, materialLimit);
    const bonus = nation.treasury?.researchFunding && baseBudget >= 0.1
      ? Math.min(capacity * 0.6, materialLimit - baseBudget, nation.treasury.balance / 2) : 0;
    const budget = baseBudget + bonus;
    let usedBudget = 0;
    for (const family of EQUIPMENT_FAMILIES) {
      if (!weights[family]) continue;
      const program = getResearchPortfolio(world, nation.id, family), priorities = getResearchPriorities(world, nation.id, family);
      const sum = Object.values(priorities).reduce((value, item) => value + item, 0);
      const materials = getPrototypeMaterialRates(nation.resources, family);
      const science = materials.reduce((limit, [resource, rate]) =>
        Math.min(limit, Math.max(0, (nation.resources[resource] ?? 0) - 2) / rate), budget * weights[family] / total);
      if (budget < 0.1 || science <= 0) { program.status = "saving resources"; continue; }
      for (const [resource, rate] of materials) changeResource(nation, resource, -science * rate);
      usedBudget += science;
      program.primaryBranch = [...FAMILY_RESEARCH_BRANCHES[family]].sort((a, b) => priorities[b] - priorities[a])[0]!;
      program.lastScience = science; program.totalScience += science; program.status = "researching";
      for (const branch of FAMILY_RESEARCH_BRANCHES[family]) {
        if (!priorities[branch]) continue;
        program.progress[branch] += science * priorities[branch] / sum;
        const cost = getResearchCost(program, branch);
        if (program.progress[branch] + 1e-9 < cost) continue;
        program.progress[branch] = Math.max(0, program.progress[branch] - cost); program.levels[branch]++; program.completedProjects++;
        recordSimulationEvent(world, { category: "research", nationIds: [nation.id], message: `${nation.id} completed ${EQUIPMENT_FAMILY_NAMES[family]} / ${RESEARCH_BRANCH_NAMES[branch]} level ${program.levels[branch]}.` });
      }
    }
    const steel = usedBudget * 0.4, weapons = usedBudget * 0.2;
    if (usedBudget > 0) {
      changeResource(nation, "steel", -steel);
      changeResource(nation, "weapons", -weapons);
      state.steelSpent += steel; state.weaponsSpent += weapons;
      if (nation.treasury && usedBudget > baseBudget) spendTreasury(nation.treasury, "research", (usedBudget - baseBudget) * 2);
    }
  }
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
