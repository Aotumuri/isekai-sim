import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getInfluence, getRelation } from "../../src/sim/diplomacy";
import { launchPoliticalCampaign, POLITICAL_CAMPAIGN_COST, updateForeignPoliticalInfluence } from "../../src/sim/political-influence";
import { getNationalPolitics, increasePoliticalSupport, updateNationalPolitics } from "../../src/sim/politics";
import { declareWar } from "../../src/sim/war-state";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { createSocietyWorld } from "../helpers/society-world";

function scene() {
  const world = createSocietyWorld();
  const [a, b] = getAdjacentNationPairs(world)[0]!;
  const sponsor = world.nations.find((nation) => nation.id === a)!;
  const target = world.nations.find((nation) => nation.id === b)!;
  sponsor.ideologyId = "capitalism";
  target.ideologyId = "communism";
  const politics = getNationalPolitics(world, target);
  politics.system = "democracy";
  politics.seats = new Map(politics.support);
  return { world, sponsor, target, politics };
}

test("foreign sponsorship changes public support without rewriting the parliament", () => {
  const { world, sponsor, target, politics } = scene();
  const relation = getRelation(world, sponsor.id, target.id);
  const { trust, tension } = relation;
  const before = getInfluence(world, sponsor.id);
  increasePoliticalSupport(politics, "capitalism", 14);
  const seats = new Map(politics.seats);
  const publicSupport = politics.support.get("capitalism")!;
  assert.ok(launchPoliticalCampaign(world, sponsor.id, target.id));
  assert.equal(politics.support.get("capitalism"), publicSupport + 9);
  assert.deepEqual(politics.seats, seats);
  assert.equal(target.ideologyId, "communism");
  assert.equal(getInfluence(world, sponsor.id), before - POLITICAL_CAMPAIGN_COST);
  assert.equal(relation.trust, trust - 4);
  assert.equal(relation.tension, tension + 9);
  assert.equal(launchPoliticalCampaign(world, sponsor.id, target.id), false);
  assert.equal(getInfluence(world, sponsor.id), before - POLITICAL_CAMPAIGN_COST);
  world.time.slowTick = politics.nextMandateAt;
  updateNationalPolitics(world);
  assert.equal(target.ideologyId, "capitalism");
});

test("AI sponsors a competitive foreign movement while retaining an influence reserve", () => {
  const { world, sponsor, target, politics } = scene();
  sponsor.character = { doctrine: "expansionist", aggression: 0.9, cooperation: 0.3, innovation: 0.5, thrift: 0.3 };
  getDiplomacyState(world).influenceByNationId.set(sponsor.id, 70);
  for (const nation of world.nations) if (nation !== sponsor && nation !== target) nation.macroRegionIds = [];
  const before = politics.support.get("capitalism")!;
  world.time.slowTick = 180;
  updateForeignPoliticalInfluence(world);
  assert.equal(politics.support.get("capitalism"), before + 9);
  assert.equal(getInfluence(world, sponsor.id), 70 - POLITICAL_CAMPAIGN_COST);
  declareWar(world.wars, sponsor.id, target.id, 0);
  world.time.slowTick = 360;
  assert.equal(launchPoliticalCampaign(world, sponsor.id, target.id), false);
});
