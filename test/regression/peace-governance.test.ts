import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGIC_RESOURCES } from "../../src/data/strategic-resources";
import { annexedOutputFactor, recordAnnexation, updateAnnexations } from "../../src/sim/annexation";
import { planPuppetPartition } from "../../src/sim/puppet-partition";
import { getNationalPolitics } from "../../src/sim/politics";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { getSubjectOverlord, installSubjectGovernment } from "../../src/sim/subject-governments";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { setTradeEmbargo } from "../../src/sim/trade-embargo";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings();
  return world;
}

test("annexation lowers output and resistance recovers over time", () => {
  const world = scene(), owner = world.nations[0]!;
  const id = owner.capitalMesoId;
  recordAnnexation(world, owner.id, [id]);
  const start = annexedOutputFactor(world, owner.id, id);
  assert(start < 1);
  world.time.slowTick = 10;
  updateAnnexations(world);
  assert(annexedOutputFactor(world, owner.id, id) > start);
  assert.equal(annexedOutputFactor(world, world.nations[1]!.id, id), 1);
});

test("partition terms are revalidated and create two subjects without duplicating resources", () => {
  const world = scene(), overlord = world.nations[0]!;
  let target = world.nations[1]!;
  let partition;
  for (const candidate of world.nations.slice(1)) {
    world.occupation.mesoById.clear();
    for (const [id, owner] of getOwnerByMesoId(world)) {
      if (owner === candidate.id) world.occupation.mesoById.set(id, overlord.id);
    }
    partition = planPuppetPartition(world, overlord.id, candidate.id, []);
    if (partition) { target = candidate; break; }
  }
  assert(partition);
  world.settings!.politicalTurbulenceEnabled = true;
  const politics = getNationalPolitics(world, overlord);
  const support = new Map(politics.support);
  const war = declareWar(world.wars, overlord.id, target.id, 0)!;
  war.openingAggressorIdeologyId = politics.governingIdeologyId;
  war.contributionByNationId.set(target.id, 9_600);
  const terms = { ...whitePeaceTerms(), partition };
  const before = new Map(world.occupation.mesoById), count = world.nations.length;
  const keys = ["steel", "fuel", "weapons", "manpower", ...STRATEGIC_RESOURCES] as const;
  for (const [index, key] of keys.entries()) target.resources[key] = 100 + index;
  const stockBefore = { ...target.resources }, cashBefore = target.treasury!.balance, grainBefore = target.food!.stock;
  assert(proposePeaceTerms(world, overlord.id, target.id, terms));
  world.occupation.mesoById.delete(target.capitalMesoId);
  assert(!acceptPeaceOffer(world, target.id, overlord.id));
  assert(findWar(world.wars, overlord.id, target.id));
  assert.equal(world.nations.length, count);
  assert.deepEqual(target.resources, stockBefore);
  world.occupation.mesoById = before;
  assert(acceptPeaceOffer(world, target.id, overlord.id));
  const successor = world.nations.at(-1)!;
  assert.equal(world.nations.length, count + 1);
  assert.equal(getSubjectOverlord(world, target.id), overlord.id);
  assert.equal(getSubjectOverlord(world, successor.id), overlord.id);
  assert.deepEqual(politics.support, support);
  assert.equal(successor.capitalMesoId, partition.capitalId);
  assert(partition.districtIds.every((id) => getOwnerByMesoId(world).get(id) === successor.id));
  for (const key of keys) assert(Math.abs(successor.resources[key]! + target.resources[key]! - stockBefore[key]!) < 1e-8);
  assert(Math.abs(successor.treasury!.balance + target.treasury!.balance - cashBefore) < 1e-8);
  assert(Math.abs(successor.food!.stock + target.food!.stock - grainBefore) < 1e-8);
  assert(!acceptPeaceOffer(world, target.id, overlord.id));
});

test("a subject with high independence pressure can negotiate release from a weakened overlord", () => {
  const world = scene(), [overlord, subject] = world.nations;
  assert(overlord && subject);
  installSubjectGovernment(world, overlord.id, subject.id);
  subject.subjectGovernment!.autonomy = 100;
  overlord.warCooperation = 0;
  world.time.slowTick = 30;
  world.time.fastTick = 300;
  updateSubjectAutonomy(world);
  assert.equal(getSubjectOverlord(world, subject.id), overlord.id);
  world.time.slowTick = 40;
  world.time.fastTick = 400;
  updateSubjectAutonomy(world);
  assert.equal(getSubjectOverlord(world, subject.id), undefined);
});

function industryScene() {
  const world = createFixedSocietyWorld();
  const [overlord, subject] = world.nations;
  installSubjectGovernment(world, overlord.id, subject.id);
  updateSupplyAssessment(world);
  subject.subjectGovernment!.autonomy = 30;
  subject.resources.steel = 0;
  subject.resources.fuel = 11;
  subject.resourceFlow.productionSurplus = { steel: 2, fuel: 0 };
  overlord.resources.steel = overlord.resources.fuel = 50;
  world.time.slowTick = 10;
  return { world, overlord, subject, government: subject.subjectGovernment! };
}

test("subject support uses projected output and covers only the remaining reserve shortfall", () => {
  const { world, overlord, subject, government } = industryScene();
  updateSubjectAutonomy(world);
  assert.equal(subject.resources.steel, 0);
  assert.equal(overlord.resources.steel, 50);
  assert.equal(subject.resources.fuel, 12);
  assert.equal(overlord.resources.fuel, 49);
  const pressureWithSupport = government.autonomy!;

  const isolated = industryScene();
  assert(setTradeEmbargo(isolated.world, isolated.subject.id, isolated.overlord.id, true));
  updateSubjectAutonomy(isolated.world);
  assert.equal(isolated.subject.resources.fuel, 11);
  assert.equal(isolated.overlord.resources.fuel, 50);
  assert(isolated.government.autonomy! > pressureWithSupport);
  assert(isolated.government.industrialAidRouteBlocked);
  isolated.world.time.slowTick += 10;
  updateSubjectAutonomy(isolated.world);
  assert.equal(isolated.world.events?.filter(({ message }) => message.includes("no open route")).length, 1);
  assert(setTradeEmbargo(isolated.world, isolated.subject.id, isolated.overlord.id, false));
  isolated.world.time.slowTick += 10;
  updateSubjectAutonomy(isolated.world);
  assert.equal(isolated.subject.resources.fuel, 12);
  assert(!isolated.government.industrialAidRouteBlocked);
  assert(isolated.world.events?.some(({ message }) => message.includes("route reopened")));
});

test("the overlord keeps enough fuel for its own demand", () => {
  const { world, overlord, subject } = industryScene();
  subject.resources.fuel = 0;
  overlord.resourceFlow.usage.fuel = 8;
  overlord.resources.fuel = 41;
  updateSubjectAutonomy(world);
  assert.equal(subject.resources.fuel, 1);
  assert.equal(overlord.resources.fuel, 40);
});
