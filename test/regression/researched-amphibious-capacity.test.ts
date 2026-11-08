import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { getResearchPortfolio, getNationalDesign } from "../../src/sim/research";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { allFieldUnits } from "../../src/sim/mobilization";
import { getUnitTransportCapacity } from "../../src/sim/unit-capabilities";

test("the actual amphibious embarkation path carries more than ten troops on a researched hull without losing identities", () => {
  const world = createScenarioWorld("two-island-amphibious", { seed: 695919685365, width: 640, height: 360, quick: true });
  const [defender, attacker] = world.nations;
  defender.nextUnitProductionTick = Infinity;
  world.units = world.units.filter((unit) => unit.nationId !== defender.id || unit.domain !== "naval");
  getResearchPortfolio(world, attacker.id, "TransportShip").levels.capacity = 10;
  for (const unit of world.units) if (unit.nationId === attacker.id && unit.type === "TransportShip") unit.design = getNationalDesign(world, attacker.id, "TransportShip");
  withMutedSimulationLogs(() => {
    for (let tick = 0; tick < 1500 && !world.amphibiousOperations.operations.length; tick++) runSimulation(world, { ticks: 1 });
  });
  const operation = world.amphibiousOperations.operations.find((item) => item.nationId === attacker.id && item.phase === "preparing");
  assert(operation, "a real planned amphibious operation must reach embarkation readiness");
  const required = operation.transportIds.length * 10 + 1;
  while (operation.assignedUnitIds.length < required) {
    const unit = createUnitForType(createUnitId(world.unitIdCounter++), attacker.id, operation.departurePortId, "Infantry");
    unit.amphibiousEmbarkRequested = true; world.units.push(unit);
    operation.assignedUnitIds.push(unit.id);
    operation.manifest.push({ ...operation.manifest[0]!, unitId: unit.id });
    world.amphibiousOperations.operationByUnitId.set(unit.id, operation);
  }
  const forceIds = new Set(operation.assignedUnitIds);
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 1 }));
  const transports = world.units.filter((unit) => operation.transportIds.includes(unit.id));
  assert(transports.some((unit) => unit.cargoUnits.length > 10));
  for (const transport of transports) assert(transport.cargoUnits.length <= getUnitTransportCapacity(transport));
  const all = allFieldUnits(world);
  assert.equal(all.filter((unit) => forceIds.has(unit.id)).length, forceIds.size);
  assert.equal(new Set(all.map((unit) => unit.id)).size, all.length);
});
