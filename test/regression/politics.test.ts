import assert from "node:assert/strict";
import test from "node:test";
import { startPlayerWar } from "../../src/sim/diplomatic-crises";
import { concludePeace } from "../../src/sim/diplomatic-peace";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { updateCivilWar } from "../../src/sim/civil-war";
import { declareWar } from "../../src/sim/war-state";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { getIdeologicalAffinity } from "../../src/sim/ideology-relations";
import { getNationCharacter } from "../../src/sim/nation-character";
import { getNationalPolitics, increasePoliticalSupport, updateNationalPolitics } from "../../src/sim/politics";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { createSocietyWorld } from "../helpers/society-world";

test("an expensive failed offensive can change the next election without replacing the sitting government", () => {
  const world = createFixedSocietyWorld();
  world.settings!.politicalTurbulenceEnabled = true;
  const [attacker, defender] = world.nations;
  attacker.ideologyId = "communism";
  const politics = getNationalPolitics(world, attacker);
  politics.system = "democracy";
  politics.coalition = ["communism", "cohesionism"];
  politics.support = new Map([["communism", 46], ["capitalism", 44], ["cohesionism", 10]]);
  politics.seats = new Map(politics.support);
  assert(enterPlayerNation(world, attacker.id));
  assert(startPlayerWar(world, defender.id));
  const war = world.wars[0]!;
  assert.equal(war.openingAggressorIdeologyId, "communism");
  war.contributionByNationId.set(defender.id, 4_800);
  assert(concludePeace(world, attacker.id, defender.id));
  assert(!concludePeace(world, attacker.id, defender.id));
  assert.deepEqual([...politics.support.values()], [42, 48, 10]);
  assert.deepEqual([...politics.seats.values()], [46, 44, 10]);
  assert.equal(attacker.ideologyId, "communism");
  world.time.slowTick = politics.nextMandateAt;
  updateNationalPolitics(world);
  assert.equal(attacker.ideologyId, "capitalism");
});

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
  unrest.lowSupportSlowTicks = 300;

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
