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

test("thousands of nations exhaust the base combinations without numeric country names or simulation randomness", () => {
  const a = createSocietyWorld(), b = createSocietyWorld();
  const templateA = a.nations[0]!, templateB = b.nations[0]!;
  a.nations = Array.from({ length: 5_000 }, (_, index) => ({ ...templateA, id: `nation-${index}` as typeof templateA.id, name: undefined, ideologyId: undefined }));
  b.nations = Array.from({ length: 5_000 }, (_, index) => ({ ...templateB, id: `nation-${index}` as typeof templateB.id, name: undefined, ideologyId: undefined })).reverse();
  assignNationIdentities(a); assignNationIdentities(b);
  const names = new Map(b.nations.map((nation) => [nation.id, nation.name]));
  assert.equal(new Set(a.nations.map((nation) => nation.name!.toLowerCase())).size, 5_000);
  for (const nation of a.nations) {
    assert.match(nation.name!, /^[A-Z][a-z]+$/);
    assert.equal(nation.name, names.get(nation.id));
  }
  assert.equal(a.simRng.nextFloat(), b.simRng.nextFloat());
});

test("a colliding existing name is reserved case-insensitively and new states do not rename established countries", () => {
  const world = createSocietyWorld(), template = world.nations[0]!;
  const generated = template.name!;
  const reserved = { ...template, id: "reserved-nation" as typeof template.id, name: generated.toLowerCase() };
  template.name = undefined; world.nations.push(reserved);
  assignNationIdentities(world);
  assert.notEqual(template.name!.toLowerCase(), reserved.name);
  assert.equal(reserved.name, generated.toLowerCase());
  const established = world.nations.map((nation) => nation.name);
  world.nations.push({ ...template, id: "new-rebel-state" as typeof template.id, name: undefined, ideologyId: undefined });
  assignNationIdentities(world);
  assert.deepEqual(world.nations.slice(0, -1).map((nation) => nation.name), established);
  assert.match(world.nations.at(-1)!.name!, /^[A-Z][a-z]+$/);
});
