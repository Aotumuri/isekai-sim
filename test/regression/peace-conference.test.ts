import assert from "node:assert/strict";
import test from "node:test";
import { getRelation, hasTreaty } from "../../src/sim/diplomacy";
import { createFaction, getFactionState, getNationFaction, leaveFaction } from "../../src/sim/factions";
import { getNationIdeology } from "../../src/sim/nation-identity";
import { openPeaceConference, respondToPeaceConference, updatePeaceConferences } from "../../src/sim/peace-conference";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { declareWar, findWar } from "../../src/sim/war-state";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings();
  const [a, b, c, d] = world.nations;
  assert(a && b && c && d);
  getRelation(world, a.id, b.id).treaties.push({ type: "alliance", expiresAtSlowTick: 1000 });
  declareWar(world.wars, c.id, a.id, 0);
  declareWar(world.wars, c.id, b.id, 0);
  declareWar(world.wars, c.id, d.id, 0);
  return { world, a, b, c, d };
}

test("a joint peace waits for all signatories and preserves unrelated wars", () => {
  const { world, a, b, c, d } = scene();
  assert(openPeaceConference(world, a.id, c.id));
  const conference = world.peaceConferences![0]!;
  assert.equal(conference.wars.length, 2);
  assert(respondToPeaceConference(world, conference.id, c.id, true));
  assert(findWar(world.wars, a.id, c.id));
  assert(respondToPeaceConference(world, conference.id, b.id, true));
  assert(!findWar(world.wars, a.id, c.id));
  assert(!findWar(world.wars, b.id, c.id));
  assert(findWar(world.wars, d.id, c.id));
  assert(hasTreaty(world, a.id, c.id, "truce"));
  assert(hasTreaty(world, b.id, c.id, "truce"));
});

test("separate peace invalidates an outstanding joint offer without ending another war", () => {
  const { world, a, b, c } = scene();
  assert(openPeaceConference(world, a.id, c.id));
  assert(proposePeaceTerms(world, c.id, b.id, whitePeaceTerms()));
  assert(acceptPeaceOffer(world, b.id, c.id));
  world.time.slowTick = 5;
  updatePeaceConferences(world);
  assert.equal(world.peaceConferences?.length, 0);
  assert(findWar(world.wars, a.id, c.id));
});

test("joint-only faction members can withdraw and sign separately", () => {
  const { world, a, b, c } = scene();
  const faction = createFaction(world, a.id, {
    allowedIdeologyIds: [getNationIdeology(world, a.id).id],
    defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: false, jointPeaceOnly: true,
  });
  assert(faction);
  faction.memberIds.push(b.id);
  getFactionState(world).factionByNationId.set(b.id, faction);
  assert(proposePeaceTerms(world, c.id, b.id, whitePeaceTerms()));
  assert(!acceptPeaceOffer(world, b.id, c.id));
  assert(leaveFaction(world, b.id));
  assert.equal(getNationFaction(world, b.id), undefined);
  assert(acceptPeaceOffer(world, b.id, c.id));
  assert(findWar(world.wars, a.id, c.id));
});
