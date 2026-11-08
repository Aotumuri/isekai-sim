import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { getResearchPortfolio } from "../../src/sim/research";
import { licenseTechnology } from "../../src/sim/technology-exchange";
import { createSocietyWorld } from "../helpers/society-world";

test("technology licenses accelerate domestic research, cost resources and cannot be spammed", () => {
  const world = createSocietyWorld(), [a, b] = world.nations.slice(0, 2);
  assert(a && b);
  b.resources.weapons = 50; b.resources.steel = 50;
  const relation = getRelation(world, a.id, b.id); relation.trust = 80; relation.opinion = 80;
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  assert(proposeTreaty(world, a.id, b.id, "alliance"));
  getResearchPortfolio(world, a.id).levels.reliability = 4;
  const target = getResearchPortfolio(world, b.id), before = a.resources.weapons;
  assert(licenseTechnology(world, a.id, b.id, "reliability"));
  assert(target.progress.reliability > 0);
  assert.equal(target.levels.reliability, 0);
  assert.equal(b.resources.weapons, 46); assert.equal(b.resources.steel, 48);
  assert.equal(a.resources.weapons, before + 4);
  const progress = target.progress.reliability;
  assert.equal(licenseTechnology(world, a.id, b.id, "reliability"), false);
  assert.equal(target.progress.reliability, progress);
  world.settings!.researchEnabled = false; world.time.slowTick += 120;
  assert.equal(licenseTechnology(world, a.id, b.id, "reliability"), false);
});

test("technology licensing transfers only the specified equipment program", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  b.resources.weapons = b.resources.steel = 100;
  const relation = getRelation(world, a.id, b.id); relation.trust = relation.opinion = 80;
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 1000 });
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  getResearchPortfolio(world, a.id, "Tank").levels.armor = 5;
  assert(licenseTechnology(world, a.id, b.id, "armor", "Tank"));
  assert(getResearchPortfolio(world, b.id, "Tank").progress.armor > 0);
  assert.equal(getResearchPortfolio(world, b.id).progress.armor, 0);
  assert(!licenseTechnology(world, a.id, b.id, "armor", "Infantry"));
});
