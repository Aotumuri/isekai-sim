import { concludePeace } from "../../src/sim/diplomatic-peace";
import assert from "node:assert/strict";
import { createSeededWorld } from "../helpers/seeded-world";
import { allFieldUnits, getMobilization, getArmyLimits, updateMobilization, updateDemobilization } from "../../src/sim/mobilization";
import { updateWarCooperation } from "../../src/sim/war-cooperation";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateProduction } from "../../src/sim/production";
import { getRelation } from "../../src/sim/diplomacy";
import { declareWar } from "../../src/sim/war-state";

// Isolate recruitment and civilian burden from combat losses and movement.
const world = createSeededWorld({ seed: 822748319788, quick: true, config: { systems: {
  mobilizationEnabled: true, diplomacyEnabled: false, researchEnabled: false, tradeEnabled: false, armsAidEnabled: false,
} } });
const [a, b] = world.nations;
for (const nation of world.nations) { nation.resources.manpower = 1_000_000; nation.resources.weapons = 100_000; nation.resources.steel = 100_000; }
const item = getMobilization(world, a.id);
let peakArmy = 0, peakStrain = 0;
const run = (seconds: number) => {
  for (let step = 0; step < seconds; step++) {
    world.time.slowTick++; world.time.fastTick += 10; world.time.elapsedMs += 1000;
    for (let fast = 0; fast < 10; fast++) updateWarCooperation(world);
    updateMobilization(world); updateSupplyAssessment(world); updateProduction(world); updateDemobilization(world);
    const count = allFieldUnits(world).filter((unit) => unit.nationId === a.id && unit.domain === "land").length;
    peakArmy = Math.max(peakArmy, count); peakStrain = Math.max(peakStrain, item.burden);
    assert(count <= 300); assert(Number.isFinite(item.burden) && item.burden >= 0 && item.burden <= 100);
    for (const nation of world.nations) for (const amount of Object.values(nation.resources)) assert(Number.isFinite(amount) && amount >= 0);
  }
  return allFieldUnits(world).filter((unit) => unit.nationId === a.id && unit.domain === "land").length;
};
const peacetimeArmy = run(120);
assert(peacetimeArmy <= getArmyLimits(world, a).standing);
getRelation(world, a.id, b.id).crisis = { aggressorId: b.id, openedAtSlowTick: world.time.slowTick, deadlineSlowTick: world.time.slowTick + 30, demand: "concessions" };
const prewarArmy = run(30); assert(prewarArmy > peacetimeArmy);
getRelation(world, a.id, b.id).crisis = null;
declareWar(world.wars, a.id, b.id, world.time.fastTick);
const wartimeArmy = run(150); assert(peakArmy > 100);
world.settings!.diplomacyEnabled = true;
assert(concludePeace(world, a.id, b.id));
const finalArmy = run(700);
assert(finalArmy <= getArmyLimits(world, a).standing);
assert(item.demobilized > 0 && item.returnedManpower > 0 && item.recoveredWeapons > 0);
assert(item.burden < peakStrain);
console.log(JSON.stringify({ peacetimeArmy, prewarArmy, wartimeArmy, peakArmy, finalArmy, finalStanding: getArmyLimits(world, a).standing,
  peakStrain, finalStrain: item.burden, demobilized: item.demobilized, returnedManpower: item.returnedManpower,
  recoveredWeapons: item.recoveredWeapons, hardLimit: 300 }));
