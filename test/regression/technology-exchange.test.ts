import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { getResearchCost, getResearchPortfolio, updateResearch } from "../../src/sim/research";
import { licenseTechnology } from "../../src/sim/technology-exchange";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
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

test("late licenses boost research without directly granting levels or exceeding the project cost", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  b.resources.weapons = b.resources.steel = b.resources.copper = 100;
  const relation = getRelation(world, a.id, b.id); relation.trust = relation.opinion = 80;
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 1000 });
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  getResearchPortfolio(world, a.id).levels.firepower = 100;
  const target = getResearchPortfolio(world, b.id);
  target.focus = "firepower";
  target.levels.firepower = 20;
  const cost = getResearchCost(target, "firepower");
  target.progress.firepower = cost - 20;
  assert(licenseTechnology(world, a.id, b.id, "firepower"));
  assert(target.progress.firepower < cost && target.progress.firepower > cost - 20);
  assert.equal(target.levels.firepower, 20);
  assert.equal(b.resources.weapons, 96);
  assert.equal(b.resources.steel, 98);
  assert.equal(licenseTechnology(world, a.id, b.id, "firepower"), false);
  updateSupplyAssessment(world);
  updateResearch(world);
  assert.equal(target.levels.firepower, 21);
});
