import assert from "node:assert/strict";
import test from "node:test";
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
