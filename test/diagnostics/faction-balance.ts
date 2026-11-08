import { createSeededWorld } from "../helpers/seeded-world";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateDiplomaticRelations } from "../../src/sim/diplomacy";
import { updateFactions } from "../../src/sim/factions";
import { getNationIdeology } from "../../src/sim/nation-identity";

const seeds = [101, 202, 303, 404, 505, 606, 695919685365, 822748319788];
const rows: { multiNationBlocs: number; largestBlocShare: number; opposedPairs: number }[] = [];
for (const seed of seeds) {
  const world = createSeededWorld({ seed, width: 960, height: 540, quick: true,
    config: { nationTargetMacroRegionsPerNation: 1, systems: createSimulationSettings({ mobilizationEnabled: false, researchEnabled: false, tradeEnabled: false, armsAidEnabled: false }) } });
  let peakMultiNationBlocs = 0;
  for (let second = 0; second <= 1800; second += 10) {
    world.time.slowTick = second; world.time.fastTick = second * 10; world.time.elapsedMs = second * 1000;
    updateDiplomaticRelations(world); updateFactions(world);
    peakMultiNationBlocs = Math.max(peakMultiNationBlocs, world.factions?.factions.filter((faction) => faction.memberIds.length >= 2).length ?? 0);
  }
  const factions = world.factions?.factions ?? [];
  let opposedPairs = 0, memberPairs = 0;
  for (const faction of factions) for (let i = 0; i < faction.memberIds.length; i++) for (let j = i + 1; j < faction.memberIds.length; j++) {
    const ideologies = [getNationIdeology(world, faction.memberIds[i]).id, getNationIdeology(world, faction.memberIds[j]).id];
    memberPairs++; if (ideologies.includes("capitalism") && ideologies.includes("communism")) opposedPairs++;
  }
  const row = { seed, nations: world.nations.length, factions: factions.length, multiNationBlocs: factions.filter((faction) => faction.memberIds.length >= 2).length,
    largestBlocShare: Math.max(0, ...factions.map((faction) => faction.memberIds.length)) / world.nations.length,
    independent: world.nations.length - (world.factions?.factionByNationId.size ?? 0), opposedPairs, memberPairs, peakMultiNationBlocs,
    memberships: factions.map((faction) => faction.memberIds.map((id) => getNationIdeology(world, id).id)) };
  rows.push(row); console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ summary: true, samples: rows.length,
  averageMultiNationBlocs: rows.reduce((sum, row) => sum + row.multiNationBlocs, 0) / rows.length,
  averageLargestBlocShare: rows.reduce((sum, row) => sum + row.largestBlocShare, 0) / rows.length,
  opposedPairs: rows.reduce((sum, row) => sum + row.opposedPairs, 0) }));
