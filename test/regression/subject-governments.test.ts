import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation, hasTreaty, proposeTreaty } from "../../src/sim/diplomacy";
import { startDiplomaticWar, updateDiplomaticCrises } from "../../src/sim/diplomatic-crises";
import { createFaction, getNationFaction } from "../../src/sim/factions";
import { getMilitaryRoutingOwners, hasMilitaryAccess } from "../../src/sim/military-access";
import { getNationIdeology } from "../../src/sim/nation-identity";
import { getSubjectOverlord, releaseSubjectGovernment, updateSubjectGovernments } from "../../src/sim/subject-governments";
import { acceptPeaceOffer, getPeaceTermsIssue, getWarNegotiation, proposePeaceTerms, updateWarNegotiations, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { declareWar, findWar } from "../../src/sim/war-state";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";

const terms = { ...whitePeaceTerms(), puppetTarget: true };

function scene() {
  const world = createFixedSocietyWorld();
  const [overlord, target, , third] = world.nations;
  overlord.ideologyId = "capitalism";
  target.ideologyId = "communism";
  declareWar(world.wars, overlord.id, target.id, 0);
  const owned = [...getOwnerByMesoId(world)].filter(([, owner]) => owner === target.id).map(([id]) => id);
  const occupy = () => {
    for (const id of [target.capitalMesoId, ...owned.filter((id) => id !== target.capitalMesoId)].slice(0, Math.ceil(owned.length * 0.3))) {
      world.occupation.mesoById.set(id, overlord.id);
    }
    world.occupation.version++;
  };
  return { world, overlord, target, third, occupy };
}

test("puppet peace preserves the defeated country and replaces its foreign military alignment", () => {
  const { world, overlord, target, third, occupy } = scene();
  const owners = new Map(getOwnerByMesoId(world));
  assert.equal(proposePeaceTerms(world, overlord.id, target.id, terms), false);
  occupy();
  const faction = createFaction(world, target.id, {
    allowedIdeologyIds: ["communism"], defensiveObligation: "none", offensiveObligation: "none", considerPersonality: false,
  });
  assert.ok(faction);
  const thirdRelation = getRelation(world, target.id, third.id);
  thirdRelation.treaties.push({ type: "alliance", expiresAtSlowTick: 900 });
  assert.ok(proposePeaceTerms(world, overlord.id, target.id, terms));
  assert.ok(acceptPeaceOffer(world, target.id, overlord.id));

  assert.deepEqual(getOwnerByMesoId(world), owners);
  assert.equal(findWar(world.wars, overlord.id, target.id), null);
  assert.equal(getSubjectOverlord(world, target.id), overlord.id);
  assert.equal(getNationIdeology(world, target.id).id, "capitalism");
  assert.equal(getNationFaction(world, target.id), undefined);
  assert.equal(hasTreaty(world, target.id, third.id, "alliance"), false);
  assert.equal(hasMilitaryAccess(world, overlord.id, target.id), true);
  assert.equal(hasMilitaryAccess(world, target.id, overlord.id), true);
  assert.equal(getMilitaryRoutingOwners(world, overlord.id).get(target.capitalMesoId), overlord.id);
  getDiplomacyState(world).influenceByNationId.set(target.id, 100);
  thirdRelation.trust = 100;
  thirdRelation.opinion = 100;
  assert.equal(proposeTreaty(world, target.id, third.id, "alliance"), false);

  assert.equal(startDiplomaticWar(world, target.id, third.id), false);
  world.time.fastTick += 10;
  world.time.slowTick += 10;
  assert.ok(startDiplomaticWar(world, third.id, target.id));
  updateDiplomaticCrises(world);
  assert.equal(findWar(world.wars, overlord.id, third.id)?.cause, "defensive-alliance");
});

test("puppet terms are revalidated at acceptance and grant independence removes access", () => {
  const { world, overlord, target, third, occupy } = scene();
  occupy();
  assert.ok(proposePeaceTerms(world, overlord.id, target.id, terms));
  world.occupation.mesoById.clear();
  assert.equal(acceptPeaceOffer(world, target.id, overlord.id), false);
  assert.ok(findWar(world.wars, overlord.id, target.id));
  occupy();
  assert.match(getPeaceTermsIssue(world, overlord.id, target.id, { ...terms, demandedRegionIds: [target.capitalMesoId] })!, /首都を残す/);
  assert.ok(acceptPeaceOffer(world, target.id, overlord.id));
  assert.equal(releaseSubjectGovernment(world, third.id, target.id), false);
  assert.ok(releaseSubjectGovernment(world, overlord.id, target.id));
  assert.equal(getSubjectOverlord(world, target.id), undefined);
  assert.equal(hasMilitaryAccess(world, overlord.id, target.id), false);
});

test("a subject becomes independent when its overlord loses its territory", () => {
  const { world, overlord, target, occupy } = scene();
  occupy();
  assert.ok(proposePeaceTerms(world, overlord.id, target.id, terms));
  assert.ok(acceptPeaceOffer(world, target.id, overlord.id));
  overlord.macroRegionIds = [];
  updateSubjectGovernments(world);
  assert.equal(target.subjectGovernment, undefined);
});

test("an aggressive AI with decisive leverage can demand a puppet government", () => {
  const { world, overlord, target, occupy } = scene();
  occupy();
  overlord.character = { doctrine: "expansionist", aggression: 0.9, cooperation: 0.3, innovation: 0.5, thrift: 0.3 };
  const war = findWar(world.wars, overlord.id, target.id)!;
  const negotiation = getWarNegotiation(world, war);
  for (const unit of world.units) if (unit.nationId === target.id) unit.manpower *= 0.05;
  world.time.slowTick = 31;
  world.time.fastTick = 310;
  updateWarNegotiations(world);
  const offer = negotiation.offers.get(overlord.id);
  assert.equal(offer?.source, "automatic");
  assert.equal(offer.terms.puppetTarget, true);
  assert.deepEqual(offer.terms.demandedRegionIds, []);
});
