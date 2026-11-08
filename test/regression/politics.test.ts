import assert from "node:assert/strict";
import test from "node:test";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { updateCivilWar } from "../../src/sim/civil-war";
import { declareWar } from "../../src/sim/war-state";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { getIdeologicalAffinity } from "../../src/sim/ideology-relations";
import { getNationCharacter } from "../../src/sim/nation-character";
import { getNationalPolitics, increasePoliticalSupport, updateNationalPolitics } from "../../src/sim/politics";
import { createSocietyWorld } from "../helpers/society-world";

test("elections turn support into a 100-seat majority coalition and change national policy", () => {
  const world = createSocietyWorld();
  const [nation, neighbor] = world.nations;
  nation.ideologyId = "communism";
  neighbor.ideologyId = "capitalism";
  const government = getNationalPolitics(world, nation);
  government.system = "democracy";
  government.seats = new Map(government.support);
  const character = getNationCharacter(world, nation.id);
  assert.equal(getIdeologicalAffinity(world, nation.id, neighbor.id), -1);
  increasePoliticalSupport(government, "capitalism", 20);
  assert.equal(nation.ideologyId, "communism");
  assert.notEqual(government.seats.get("capitalism"), government.support.get("capitalism"));

  world.time.slowTick = government.nextMandateAt;
  updateNationalPolitics(world);
  assert.equal(nation.ideologyId, "capitalism");
  assert.equal(getNationCharacter(world, nation.id).doctrine, "merchant");
  assert.notEqual(getNationCharacter(world, nation.id), character);
  assert.equal(getIdeologicalAffinity(world, nation.id, neighbor.id), 1);
  assert.equal([...government.seats.values()].reduce((sum, seats) => sum + seats, 0), 100);
  assert.ok(government.coalition.reduce((sum, id) => sum + government.seats.get(id)!, 0) > 50);
  assert.ok(world.events?.some((event) => event.category === "politics"));
});

test("monarchies change policy through succession and have no elected seats", () => {
  const world = createSocietyWorld();
  const nation = world.nations[0];
  nation.ideologyId = "capitalism";
  const government = getNationalPolitics(world, nation);
  government.system = "monarchy";
  government.seats.clear();
  increasePoliticalSupport(government, "cohesionism", 9);
  world.time.slowTick = government.nextMandateAt;
  updateNationalPolitics(world);
  assert.equal(nation.ideologyId, "capitalism");
  increasePoliticalSupport(government, "cohesionism", 25);
  world.time.slowTick = government.nextMandateAt;
  updateNationalPolitics(world);
  assert.equal(nation.ideologyId, "cohesionism");
  assert.equal(government.seats.size, 0);
  assert.deepEqual(government.coalition, ["cohesionism"]);
});


test("a monarchy's revolutionary opposition establishes its own parliamentary government", () => {
  const world = createSocietyWorld();
  const parent = world.nations.find((nation) => nation.macroRegionIds.length > 1 &&
    world.macroRegions.some((macro) => macro.nationId === nation.id && macro.mesoRegionIds.some((id) =>
      world.mesoRegions.find((region) => region.id === id)?.building === "city")));
  assert.ok(parent);
  const other = world.nations.find((nation) => nation.id !== parent.id)!;
  parent.ideologyId = "capitalism";
  const monarchy = getNationalPolitics(world, parent);
  monarchy.system = "monarchy";
  monarchy.seats.clear();
  increasePoliticalSupport(monarchy, "communism", 18);
  declareWar(world.wars, parent.id, other.id, 0);
  parent.warCooperation = 0;
  const unrest = getDomesticUnrest(world, parent.id);
  unrest.pressure = 100;
  unrest.lowSupportSeconds = 300;

  const count = world.nations.length;
  withMutedSimulationLogs(() => updateCivilWar(world));
  assert.equal(world.nations.length, count + 1);
  const rebel = world.nations.at(-1)!;
  const parliament = getNationalPolitics(world, rebel);
  assert.equal(parliament.system, "democracy");
  assert.equal(rebel.ideologyId, "communism");
  assert.equal(getNationCharacter(world, rebel.id).doctrine, "guardian");
  assert.equal([...parliament.seats.values()].reduce((sum, seats) => sum + seats, 0), 100);
  assert.equal(parent.ideologyId, "capitalism");
  assert.equal(monarchy.system, "monarchy");
});
