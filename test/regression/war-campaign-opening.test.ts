import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioWorld } from "../scenarios";
import { assessCampaignOpening } from "../../src/sim/war-campaign/opening-intent";
import { getOwnerByMesoId, getMesoById } from "../../src/sim/world-cache";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";
import { assessWarIntent } from "../../src/sim/war-declaration";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";

const options = { seed: 822_748_319_788, width: 640, height: 360, quick: true };

test("opening goals are deterministic accessible land targets rather than arbitrary capital fallback", () => {
  const world = createScenarioWorld("matched-war", options);
  const war = world.wars[0];
  const random = world.simRng.fork().nextFloat();
  const a = assessCampaignOpening(world, war.aggressorId, war.defenderId);
  assert.deepEqual(assessCampaignOpening(world, war.aggressorId, war.defenderId), a);
  assert.equal(world.simRng.fork().nextFloat(), random);
  assert.equal(a.rationale, "border-value");
  assert.equal(a.feasible, true);
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  assert.ok(a.objectiveRegionIds.length > 0);
  for (const id of a.objectiveRegionIds) {
    assert.equal(owners.get(id), war.defenderId);
    assert.ok(regions.get(id)!.neighbors.some((neighbor) => owners.get(neighbor.id) === war.aggressorId));
  }
});

test("a maritime opening chooses a reachable port foothold", () => {
  const world = createScenarioWorld("two-island-amphibious", options);
  const war = world.wars[0];
  const opening = assessCampaignOpening(world, war.aggressorId, war.defenderId);
  assert.equal(opening.rationale, "maritime-foothold");
  assert.equal(opening.feasible, true);
  assert.equal(getMesoById(world).get(opening.objectiveRegionIds[0])!.building, "port");
});

test("a forced war without access adopts a legal defensive purpose instead of an impossible target", () => {
  const world = createScenarioWorld("two-island-amphibious", options);
  for (const region of world.mesoRegions) if (region.building === "port") region.building = null;
  world.buildingVersion += 1;
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const war = world.wars[0];
  const goal = world.warCampaigns!.byNationId.get(war.aggressorId)!.objectives[0];
  assert.equal(goal.kind, "preserve-sovereignty");
  assert.equal(goal.rationale, "no-access-defense");
  assert.ok(goal.regionIds.length > 0);
  assert.ok(goal.regionIds.every((id) => getOwnerByMesoId(world).get(id) === war.aggressorId));
});

test("a food emergency blocks autonomous escalation only when campaigns are enabled", () => {
  const world = createScenarioWorld("matched-war", options);
  const war = world.wars[0];
  const nation = world.nations.find((item) => item.id === war.aggressorId)!;
  nation.food = { stock: 0, harvest: 0, demand: 10, rationCoverage: 0, shortageCycles: 0, deaths: 0 };
  updateStrategicThreatObservation(world);
  const candidate = { aggressorId: war.aggressorId, targetNationId: war.defenderId, route: "land" as const };
  assert.ok(!assessWarIntent(world, candidate).rejectedReasons.includes("campaign-unaffordable"));
  world.settings!.warCampaignEnabled = true;
  const assessment = assessWarIntent(world, candidate);
  assert.ok(assessment.rejectedReasons.includes("campaign-unaffordable"));
  assert.equal(assessment.aboveThreshold, false);
});
