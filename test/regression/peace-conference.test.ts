import assert from "node:assert/strict";
import test from "node:test";
import { createUnitForType } from "../../src/sim/create-units";
import { changeResource } from "../../src/sim/international-trade";
import { updateProduction } from "../../src/sim/production";
import { createUnitId } from "../../src/sim/unit";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { getRelation, hasTreaty } from "../../src/sim/diplomacy";
import { createFaction, getFactionState, getNationFaction, leaveFaction } from "../../src/sim/factions";
import { getNationIdeology } from "../../src/sim/nation-identity";
import { openPeaceConference, respondToPeaceConference, updatePeaceConferences } from "../../src/sim/peace-conference";
import { chooseResourceReparation, REPARATION_INTERVAL, updateResourceReparations } from "../../src/sim/resource-reparations";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { treatyRisk } from "../../src/sim/treaty-credibility";
import { acceptPeaceOffer, assessPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
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

test("signed resource reparations transfer available stock once per interval and expire with the truce", () => {
  const { world, c, b } = scene();
  const terms = { ...whitePeaceTerms(), resourceReparation: { resource: "fuel" as const, amount: 5 } };
  c.resources.fuel = 0;
  b.resources.fuel = 7;
  assert(!proposePeaceTerms(world, c.id, b.id, { ...terms, resourceReparation: { resource: "fuel", amount: 11 } }));
  assert(proposePeaceTerms(world, c.id, b.id, terms));
  assert(acceptPeaceOffer(world, b.id, c.id));
  const signedAt = world.time.slowTick;
  assert.equal(c.resources.fuel, 0);
  world.time.slowTick = signedAt + REPARATION_INTERVAL;
  updateResourceReparations(world);
  updateResourceReparations(world);
  assert.equal(c.resources.fuel, 5);
  assert.equal(b.resources.fuel, 2);
  assert.equal(treatyRisk(b, world.time.slowTick), 0);
  world.time.slowTick += REPARATION_INTERVAL;
  updateResourceReparations(world);
  assert.equal(c.resources.fuel, 7);
  assert.equal(b.resources.fuel, 0);
  assert(Math.abs(treatyRisk(b, world.time.slowTick) - 0.9) < 1e-9);
  b.resources.fuel = 10;
  world.time.slowTick = signedAt + terms.truceSeconds;
  updateResourceReparations(world);
  assert.equal(b.resources.fuel, 10);
  assert.equal(world.resourceReparations?.length, 0);
});

test("simultaneous peace installments split scarce stock regardless of signature order", () => {
  const { world, a, b, c, d } = scene();
  for (const creditor of [b, a]) {
    assert(proposePeaceTerms(world, creditor.id, c.id, {
      ...whitePeaceTerms(), resourceReparation: { resource: "fuel", amount: creditor === a ? 9 : 3 },
    }));
    assert(acceptPeaceOffer(world, c.id, creditor.id));
  }
  declareWar(world.wars, d.id, a.id, 0);
  assert(proposePeaceTerms(world, d.id, a.id, {
    ...whitePeaceTerms(), resourceReparation: { resource: "fuel", amount: 3 },
  }));
  assert(acceptPeaceOffer(world, a.id, d.id));
  a.resources.fuel = b.resources.fuel = d.resources.fuel = 0;
  c.resources.fuel = 8;
  const relations = [a, b].map((creditor) => getRelation(world, c.id, creditor.id));
  const trust = relations.map((relation) => relation.trust);
  world.time.slowTick = REPARATION_INTERVAL;
  updateResourceReparations(world);
  updateResourceReparations(world);
  assert.deepEqual([a, b, c, d].map((nation) => nation.resources.fuel), [6, 2, 0, 0]);
  assert.deepEqual(world.resourceReparations?.map((term) => term.lastPayment?.paid), [2, 6, 0]);
  relations.forEach((relation, index) => assert.equal(relation.trust, trust[index]! - 1));
});

test("the same concession costs more in peace talks when the payer has less stock or surplus", () => {
  const { world, c, b } = scene();
  const base = whitePeaceTerms();
  const term = { ...base, resourceReparation: { resource: "fuel" as const, amount: 10 } };
  const penalty = (truceSeconds: number) => assessPeaceOffer(world, b.id, c.id, { ...base, truceSeconds }).score -
    assessPeaceOffer(world, b.id, c.id, { ...term, truceSeconds }).score;

  b.resources.fuel = 180;
  // Nine payments over a 300-second truce, funded entirely from stock.
  assert(Math.abs(penalty(300) - 12.5) < 1e-9);
  assert(penalty(600) > penalty(300));
  b.resourceFlow.productionSurplus = { fuel: 2 };
  assert(penalty(300) < 4);
  b.resources.fuel = 0;
  b.resourceFlow.productionSurplus.fuel = 0;
  assert(Math.abs(penalty(300) - 25) < 1e-9);
});

test("the domestic surplus snapshot accounts for fuel upkeep and excludes foreign deliveries", () => {
  const world = createFixedSocietyWorld();
  const [payer, exporter] = world.nations;
  world.units = [createUnitForType(createUnitId(world.unitIdCounter++), payer.id, payer.capitalMesoId, "Tank")];
  updateProduction(world);
  assert.equal(payer.resourceFlow.income.fuel, 3);
  assert.equal(payer.resourceFlow.usage.fuel, 3);
  assert.equal(payer.resourceFlow.productionSurplus?.fuel, 0);
  assert.equal(exporter.resourceFlow.productionSurplus?.fuel, 3);
  changeResource(payer, "fuel", 15);
  assert.equal(payer.resourceFlow.income.fuel, 18);
  assert.equal(payer.resourceFlow.productionSurplus?.fuel, 0);
});

test("an existing resource pledge raises the AI's cost of a second peace deal", () => {
  const { world, a, c, d } = scene();
  c.resources.fuel = 180;
  const base = whitePeaceTerms();
  const term = { ...base, resourceReparation: { resource: "fuel" as const, amount: 10 } };
  const penalty = () => assessPeaceOffer(world, c.id, d.id, base).score -
    assessPeaceOffer(world, c.id, d.id, term).score;
  assert(Math.abs(penalty() - 12.5) < 1e-9);
  assert(proposePeaceTerms(world, a.id, c.id, term));
  assert(acceptPeaceOffer(world, c.id, a.id));
  assert(Math.abs(penalty() - 25) < 1e-9);
});

test("reparations planners choose a useful installment and scale it down for existing claims", () => {
  const { world, a, b, c } = scene();
  Object.assign(b.resources, { steel: 100, copper: 100, tungsten: 100, rubber: 100, fuel: 0 });
  c.resources.fuel = 180;
  b.resourceFlow.usage.fuel = 5;
  const proposed = chooseResourceReparation(world, b, c, 300);
  assert.deepEqual(proposed, { resource: "fuel", amount: 10 });
  assert(proposePeaceTerms(world, a.id, c.id, { ...whitePeaceTerms(), resourceReparation: proposed }));
  assert(acceptPeaceOffer(world, c.id, a.id));
  assert.deepEqual(chooseResourceReparation(world, b, c, 300), { resource: "fuel", amount: 5 });
  b.resourceFlow.productionSurplus = { fuel: 1 };
  assert.equal(chooseResourceReparation(world, b, c, 300), undefined);
});
