import assert from "node:assert/strict";
import { createSocietyWorld } from "../helpers/society-world";
import { updateWarCooperation } from "../../src/sim/war-cooperation";
import { updateCivilWar } from "../../src/sim/civil-war";
import { updateDiplomaticPeace } from "../../src/sim/diplomatic-peace";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getWarNegotiation } from "../../src/sim/war-negotiations";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
// Isolate political decisions under the same prolonged war, with armies and terrain held steady.
const results = [false, true].map((hardline) => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  const power = (id: typeof a.id) => world.units.filter((unit) => unit.nationId === id).reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  const ratio = power(a.id) / power(b.id); for (const unit of world.units) if (unit.nationId === b.id) unit.manpower *= ratio;
  const uncompromising = { doctrine: "expansionist" as const, aggression: 0.9, cooperation: 0.3, innovation: 0.5, thrift: 0.3 };
  a.character = hardline ? { ...uncompromising } : { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.8 };
  b.character = { ...uncompromising }; a.resources.weapons = b.resources.weapons = 100;
  const war = declareWar(world.wars, a.id, b.id, 0)!; getWarNegotiation(world, war);
  let firstPeace: number | null = null, firstRevolution: number | null = null;
  withMutedSimulationLogs(() => {
    for (let tick = 1; tick <= 9000; tick++) {
      world.time.fastTick = tick; world.time.slowTick = Math.floor(tick / 10); world.time.elapsedMs = tick * 100;
      updateWarCooperation(world); updateCivilWar(world);
      if (tick % 10 === 0) updateDiplomaticPeace(world);
      if (world.nations.length > 3 && firstRevolution === null) firstRevolution = tick / 10;
      if (!findWar(world.wars, a.id, b.id) && firstPeace === null) firstPeace = tick / 10;
      for (const nation of world.nations) for (const amount of Object.values(nation.resources)) assert(Number.isFinite(amount) && amount >= 0);
      if (firstPeace !== null || firstRevolution !== null) break;
    }
  });
  return { personality: hardline ? "fight-on" : "pragmatic", firstPeace, firstRevolution, unrest: getDomesticUnrest(world, a.id).pressure };
});
assert(results[0]!.firstPeace !== null && results[0]!.firstRevolution === null, "pragmatic government should escape the crisis by negotiation");
assert(results[1]!.firstRevolution !== null && results[1]!.firstRevolution! >= 300, "fight-on governments may instead face a delayed revolution");
console.log(JSON.stringify({ results, invariants: "passed" }));
