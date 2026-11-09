import assert from "node:assert/strict";
import test from "node:test";
import { annexedOutputFactor, recordAnnexation, updateAnnexations } from "../../src/sim/annexation";
import { planPuppetPartition } from "../../src/sim/puppet-partition";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { getSubjectOverlord, installSubjectGovernment } from "../../src/sim/subject-governments";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
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
  declareWar(world.wars, overlord.id, target.id, 0);
  const terms = { ...whitePeaceTerms(), puppetTarget: true, partition };
  const before = new Map(world.occupation.mesoById), count = world.nations.length;
  target.resources.steel = 100;
  assert(proposePeaceTerms(world, overlord.id, target.id, terms));
  world.occupation.mesoById.delete(target.capitalMesoId);
  assert(!acceptPeaceOffer(world, target.id, overlord.id));
  assert(findWar(world.wars, overlord.id, target.id));
  assert.equal(world.nations.length, count);
  world.occupation.mesoById = before;
  assert(acceptPeaceOffer(world, target.id, overlord.id));
  const successor = world.nations.at(-1)!;
  assert.equal(world.nations.length, count + 1);
  assert.equal(getSubjectOverlord(world, target.id), overlord.id);
  assert.equal(getSubjectOverlord(world, successor.id), overlord.id);
  assert.equal(successor.capitalMesoId, partition.capitalId);
  assert(partition.districtIds.every((id) => getOwnerByMesoId(world).get(id) === successor.id));
  assert.equal(successor.resources.steel + target.resources.steel, 100);
});

test("a subject with maximum autonomy can leave a weakened overlord", () => {
  const world = scene(), [overlord, subject] = world.nations;
  assert(overlord && subject);
  installSubjectGovernment(world, overlord.id, subject.id);
  subject.subjectGovernment!.autonomy = 100;
  overlord.warCooperation = 0;
  world.time.slowTick = 10;
  updateSubjectAutonomy(world);
  assert.equal(getSubjectOverlord(world, subject.id), undefined);
});
