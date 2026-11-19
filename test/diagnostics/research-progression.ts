import assert from "node:assert/strict";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { updateEquipmentRefits } from "../../src/sim/equipment-development";
import { isNationActive } from "../../src/sim/nation-active";
import { EQUIPMENT_FAMILIES, getResearchPortfolio, updateResearch } from "../../src/sim/research";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { daysToSlowTicks, DAYS_PER_SLOW_TICK, yearsToDays } from "../../src/sim/time";
import { stepSimulationDay } from "../../src/sim/update";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createSeededWorld } from "../helpers/seeded-world";

const scenario = process.argv[2] ?? "focused";
assert(["focused", "quick", "medium", "scale", "historical"].includes(scenario));
const checkpoints = process.argv.slice(3).map(Number);
assert(checkpoints.length && checkpoints.every((day, index) =>
  Number.isSafeInteger(day) && day > (checkpoints[index - 1] ?? 0) && day % DAYS_PER_SLOW_TICK === 0));
const settings = createSimulationSettings(scenario === "historical" ? {
  warCampaignEnabled: true, politicalTurbulenceEnabled: true, defeatedFormationsEnabled: true,
} : {});
const focused = scenario === "focused", medium = scenario === "medium", scale = scenario === "scale";
const world = withMutedSimulationLogs(() => createSeededWorld({
  seed: focused ? 101 : medium ? 822748319788 : 822748319780,
  width: focused ? 960 : 1920, height: focused ? 540 : 1080, quick: !medium && !scale,
  config: { systems: settings, ...(scale ? {
    nationTargetMacroRegionsPerNation: 1, nationMacroRegionSizeRange: { min: 7, max: 11 },
  } : {}) },
}));
const selected = world.nations.slice(0, 3);
if (focused) {
  assert.equal(selected.length, 3);
  for (const nation of world.nations) for (const family of EQUIPMENT_FAMILIES) {
    getResearchPortfolio(world, nation.id, family).priority = "paused";
  }
  for (const [index, nation] of selected.entries()) {
    const program = getResearchPortfolio(world, nation.id);
    program.priority = "high";
    program.focus = "firepower";
    program.investment = "ambitious";
    Object.assign(nation.resources, { steel: 30000, weapons: 30000, copper: index === 1 ? 5 : 30000 });
    assert(nation.treasury);
    nation.treasury.balance = 30000;
    nation.treasury.researchFunding = true;
    if (index === 2) for (const branch of ["firepower", "handling", "reliability", "materials", "logistics", "production"] as const) {
      program.levels[branch] = 10;
    }
  }
  updateSupplyAssessment(world);
}

const seenWars = new Set<string>();
let peakUnits = world.units.length;
const started = performance.now(), cpu = process.cpuUsage();
console.log(JSON.stringify({ scenario, nations: world.nations.length, districts: world.mesoRegions.length, checkpoints,
  tenYears: yearsToDays(10) }));
let previousDay = 0;
for (const day of checkpoints) {
  withMutedSimulationLogs(() => {
    for (let elapsed = previousDay; elapsed < day;) {
      if (focused) {
        elapsed += DAYS_PER_SLOW_TICK;
        world.time.fastTick = elapsed;
        world.time.slowTick = daysToSlowTicks(elapsed);
        updateResearch(world);
        updateEquipmentRefits(world);
      } else {
        stepSimulationDay(world);
        elapsed++;
      }
      if (elapsed % DAYS_PER_SLOW_TICK === 0) {
        for (const war of world.wars) seenWars.add(`${war.id}|${war.nationAId}|${war.nationBId}|${war.startedAtFastTick}`);
        peakUnits = Math.max(peakUnits, world.units.length);
      }
    }
  });
  previousDay = day;
  const active = world.nations.filter(isNationActive);
  for (const nation of world.nations) {
    assert(Object.values(nation.resources).every((value) => Number.isFinite(value) && value >= -1e-8));
    assert(!nation.treasury || (Number.isFinite(nation.treasury.balance) && nation.treasury.balance >= 0));
  }
  const rows = (focused ? selected : active).map((nation) => {
    const programs = EQUIPMENT_FAMILIES.map((family) => getResearchPortfolio(world, nation.id, family));
    const levels = programs.flatMap((program) => Object.values(program.levels));
    assert(levels.every((level) => Number.isSafeInteger(level) && level >= 0));
    assert(programs.every((program) => Object.values(program.progress).every((value) => Number.isFinite(value) && value >= 0)));
    return { id: nation.id, levels: programs.map((program) => program.levels),
      status: programs.map((program) => program.status), max: Math.max(...levels),
      projects: programs.reduce((sum, program) => sum + program.completedProjects, 0),
      science: programs.reduce((sum, program) => sum + program.totalScience, 0),
      treasury: nation.treasury?.balance, researchGrants: nation.treasury?.spent.research, stocks: nation.resources };
  });
  let force = 0, generation = 0, firepower = 1;
  for (const unit of world.units) {
    force += getUnitCombatStrength(unit);
    generation = Math.max(generation, unit.design?.generation ?? 0);
    firepower = Math.max(firepower, unit.design?.firepower ?? 1);
  }
  const usage = process.cpuUsage(cpu), wallMs = performance.now() - started;
  global.gc?.();
  console.log(JSON.stringify({ day, active: active.length, units: world.units.length, peakUnits, wars: seenWars.size,
    activeWars: world.wars.length, force, generation, firepower, steel: world.research?.steelSpent,
    weapons: world.research?.weaponsSpent, refits: world.research?.retrofits, licenses: world.research?.licensesShared,
    wallMs, cpuMs: (usage.user + usage.system) / 1000, peakRssKiB: process.resourceUsage().maxRSS,
    heapBytes: process.memoryUsage().heapUsed, rows }));
}
