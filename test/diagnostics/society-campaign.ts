import { createSeededWorld } from "../helpers/seeded-world";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { RESEARCH_BRANCHES } from "../../src/sim/research";
import { isNationActive } from "../../src/sim/nation-active";
import { getNationIdeology } from "../../src/sim/nation-identity";

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name), value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const ticks = arg("--ticks", 12000), requestedSeed = process.argv.includes("--seed") ? arg("--seed", 101) : null;
for (const seed of requestedSeed ? [requestedSeed] : [101, 695919685365, 822748319788]) {
  const world = createSeededWorld({ seed, width: 960, height: 540, quick: true });
  world.settings = createSimulationSettings({ diplomacyEnabled: !process.argv.includes("--legacy") });
  let treatyPeak = 0, levels = 0, actualBattles = 0, last = 0;
  const result = withMutedSimulationLogs(() => {
    for (let part = 0; part < ticks; part += 100) {
      runSimulation(world, { ticks: Math.min(100, ticks - part) });
      const activeTreaties = [...(world.diplomacy?.relations.values() ?? [])].reduce((sum, relation) =>
        sum + relation.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick).length, 0);
      treatyPeak = Math.max(treatyPeak, activeTreaties);
      actualBattles += world.battles.length;
      for (const nation of world.nations) for (const amount of Object.values(nation.resources)) {
        if (!Number.isFinite(amount) || amount < -1e-8) throw new Error(`Invalid resource balance at tick ${world.time.fastTick}`);
      }
      const allUnits = world.units.flatMap((unit) => [unit, ...unit.cargoUnits]);
      if (new Set(allUnits.map((unit) => unit.id)).size !== allUnits.length) throw new Error("Duplicate unit ownership");
      for (const relation of world.diplomacy?.relations.values() ?? []) {
        if (!Number.isFinite(relation.opinion) || relation.opinion < -100 || relation.opinion > 100 ||
          ![relation.trust, relation.tension, relation.grievance].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error("Invalid diplomatic relation");
        if (new Set(relation.treaties.map((treaty) => treaty.type)).size !== relation.treaties.length) throw new Error("Duplicate treaty");
      }
      for (const portfolio of world.research?.byNationId.values() ?? []) for (const branch of RESEARCH_BRANCHES) {
        if (!Number.isInteger(portfolio.levels[branch]) || portfolio.levels[branch] < 0 || portfolio.levels[branch] > 10 ||
          !Number.isFinite(portfolio.progress[branch]) || portfolio.progress[branch] < 0) throw new Error("Invalid research progress");
      }
      if (world.events && world.events.length > 200) throw new Error("Unbounded event history");
      const members = new Set<string>();
      for (const faction of world.factions?.factions ?? []) {
        if (!faction.memberIds.length || !faction.memberIds.includes(faction.leaderId)) throw new Error("Invalid faction leader");
        for (const id of faction.memberIds) {
          if (members.has(id) || world.factions?.factionByNationId.get(id) !== faction ||
            !faction.charter.allowedIdeologyIds.includes(getNationIdeology(world, id).id)) throw new Error("Invalid faction membership");
          members.add(id);
        }
      }
      if (members.size !== (world.factions?.factionByNationId.size ?? 0)) throw new Error("Stale faction membership index");
      last = world.time.fastTick;
    }
    return last;
  });
  for (const portfolio of world.research?.byNationId.values() ?? []) levels += RESEARCH_BRANCHES.reduce((sum, branch) => sum + portfolio.levels[branch], 0);
  console.log(JSON.stringify({ seed, ticks: result, activeNations: world.nations.filter(isNationActive).length,
    diplomacy: world.settings.diplomacyEnabled, legacyDeclarations: world.warIntent.declarations, declarations: world.diplomacy?.declarations ?? 0,
    crises: world.diplomacy?.crisesOpened ?? 0, resolvedCrises: world.diplomacy?.crisesResolved ?? 0,
    peaceAgreements: world.diplomacy?.peaceAgreements ?? 0, defensiveInterventions: world.diplomacy?.defensiveInterventions ?? 0,
    treatyPeak, tradeDeliveries: world.internationalTrade?.delivered ?? 0, aidDeliveries: world.diplomacy?.aidDeliveries ?? 0,
    researchLevels: levels, retrofits: world.research?.retrofits ?? 0, licenses: world.research?.licensesShared ?? 0,
    factions: world.factions?.factions.length ?? 0, factionMembers: world.factions?.factionByNationId.size ?? 0,
    factionInterventions: world.factions?.interventions ?? 0, battleSamples: actualBattles, eventCount: world.events?.length ?? 0 }));
}
