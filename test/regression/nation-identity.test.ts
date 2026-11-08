import assert from "node:assert/strict";
import test from "node:test";
import { assignNationIdentities, createIdeology, getIdeologies, getNationName } from "../../src/sim/nation-identity";
import { createSocietyWorld } from "../helpers/society-world";

test("national names and ideologies are stable, unique and independent of the simulation RNG", () => {
  const a = createSocietyWorld(), b = createSocietyWorld();
  b.nations.reverse(); assignNationIdentities(a); assignNationIdentities(b);
  for (const nation of a.nations) {
    assert.equal(nation.name, getNationName(b, nation.id));
    assert.equal(nation.ideologyId, b.nations.find((item) => item.id === nation.id)!.ideologyId);
  }
  assert.equal(new Set(a.nations.map((nation) => nation.name)).size, a.nations.length);
  assert.equal(a.simRng.nextFloat(), b.simRng.nextFloat());
});
test("custom ideologies reject duplicates and unsafe sizes and preserve existing names", () => {
  const world = createSocietyWorld(); const name = world.nations[0]!.name;
  assert(createIdeology(world, "Maritime Federalism"));
  assert.equal(createIdeology(world, "maritime federalism"), null);
  assert.equal(createIdeology(world, "x"), null);
  assert.equal(getIdeologies(world).length, 5);
  assignNationIdentities(world); assert.equal(world.nations[0]!.name, name);
});
