import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { EQUIPMENT_FAMILIES, FAMILY_RESEARCH_BRANCHES, getNationalDesign, getResearchPortfolio, getNationalResearchSummary } from "../../src/sim/research";
import { allFieldUnits } from "../../src/sim/mobilization";
import { getUnitTransportCapacity } from "../../src/sim/unit-capabilities";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
const ticks = Number(process.argv[2] ?? 12000); assert(Number.isSafeInteger(ticks) && ticks > 0);
const world = createScenarioWorld("two-island-amphibious", { seed: 695919685365, width: 640, height: 360, quick: true });
world.settings = createSimulationSettings({ diplomacyEnabled: false, legacyWarDeclarationsEnabled: false, mobilizationEnabled: false, armsAidEnabled: false, tradeEnabled: false });
for (const nation of world.nations) {
  nation.resources.steel = nation.resources.weapons = nation.resources.fuel = 5000;
  for (const family of EQUIPMENT_FAMILIES) getResearchPortfolio(world, nation.id, family).priority = "normal";
  const transports = getResearchPortfolio(world, nation.id, "TransportShip"); transports.levels.capacity = 10;
  const tanks = getResearchPortfolio(world, nation.id, "Tank"); tanks.focus = "armor"; tanks.priority = "high";
  tanks.levels.armor = 4; tanks.levels.mobility = 2;
}
// Mixed starting hull generations exercise the real lease and loading path.
for (const [index, unit] of world.units.entries()) if (unit.type !== "TransportShip" || index % 2 === 0) unit.design = getNationalDesign(world, unit.nationId, unit.type);
let peakCargo = 0, peakShipCapacity = 0, samples = 0;
withMutedSimulationLogs(() => {
  for (let elapsed = 0; elapsed < ticks; elapsed += 10) {
    runSimulation(world, { ticks: Math.min(10, ticks - elapsed) }); samples++;
    const units = allFieldUnits(world); assert.equal(new Set(units.map((unit) => unit.id)).size, units.length);
    for (const unit of units) {
      if (unit.design?.family) assert.equal(unit.design.family, unit.type);
      if (unit.type === "TransportShip") {
        const capacity = getUnitTransportCapacity(unit); assert(capacity <= 25);
        assert(unit.cargoUnits.length <= capacity); peakCargo = Math.max(peakCargo, unit.cargoUnits.length); peakShipCapacity = Math.max(peakShipCapacity, capacity);
      }
    }
    let totalScience = 0;
    for (const nation of world.nations) {
      for (const amount of Object.values(nation.resources)) assert(Number.isFinite(amount) && amount >= -1e-8);
      if (!world.research?.byNationId.has(nation.id)) continue;
      const summary = getNationalResearchSummary(world, nation.id); assert(summary.lastScience <= 4.5 + 1e-8);
      totalScience += summary.totalScience;
      for (const family of EQUIPMENT_FAMILIES) {
        const program = getResearchPortfolio(world, nation.id, family);
        for (const branch of FAMILY_RESEARCH_BRANCHES[family]) {
          assert(Number.isInteger(program.levels[branch]) && program.levels[branch] >= 0 && program.levels[branch] <= 10);
          assert(Number.isFinite(program.progress[branch]) && program.progress[branch] >= 0);
        }
      }
    }
    // Defeated non-exile countries' portfolios are intentionally discarded; the ledger may retain their spending.
    assert((world.research?.steelSpent ?? 0) + 1e-6 >= totalScience * 0.4);
  }
});
console.log(JSON.stringify({ ticks, samples, peakCargo, peakShipCapacity, landings: world.amphibiousOperations.operations.filter((operation) => operation.phase === "landed").length,
  acceptedOperations: world.amphibiousOperations.operationsAccepted, retrofits: world.research?.retrofits, invariants: "passed" }));
