import assert from "node:assert/strict";
import test from "node:test";
import { getRelation, hasTreaty } from "../../src/sim/diplomacy";
import { updatePopulationPolitics } from "../../src/sim/population-politics";
import { getNationalPolitics } from "../../src/sim/politics";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { setSubjectFoodLevy } from "../../src/sim/subject-food-levy";
import { installSubjectGovernment } from "../../src/sim/subject-governments";
import { getSubjectIntegrationIssue, setGovernancePolicy } from "../../src/sim/territorial-governance";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { worldSignature } from "../diagnostics/world-signature";

function scene() {
  const world = createFixedSocietyWorld(), [overlord, subject, third] = world.nations;
  world.settings!.politicalTurbulenceEnabled = true;
  updatePopulationPolitics(world);
  const central = getNationalPolitics(world, overlord), local = getNationalPolitics(world, subject);
  central.governingIdeologyId = local.governingIdeologyId = "capitalism";
  installSubjectGovernment(world, overlord.id, subject.id);
  overlord.character = { doctrine: "expansionist", aggression: 0.9, cooperation: 0.25, innovation: 0.95, thrift: 0.3 };
  subject.character = { doctrine: "guardian", aggression: 0.7, cooperation: 0.85, innovation: 0.55, thrift: 0.5 };
  const government = subject.subjectGovernment!;
  subject.governance = { policy: "centralized", since: 0, stability: 90, alignment: 0.22, diversity: 0.65 };
  subject.identityStability = { legitimacy: 90, grievance: 0, autonomyDemand: 0 };
  overlord.warCooperation = 0.9;
  overlord.resources.steel = subject.resources.steel = 20;
  overlord.resources.fuel = subject.resources.fuel = 20;
  world.units = [];
  const relation = getRelation(world, overlord.id, subject.id);
  const at = (tick: number) => {
    world.time.slowTick = tick;
    world.time.fastTick = tick * 10;
    updateSubjectAutonomy(world);
  };
  return { world, overlord, subject, third, government, relation, at };
}

test("a culturally aligned but self-reliant subject refuses the overlord's integration proposal", () => {
  const s = scene();
  s.subject.governance!.alignment = 1;
  s.subject.character!.cooperation = 0.20;
  s.relation.trust = 58;
  s.subject.politics!.system = "democracy";
  s.subject.politics!.governingIdeologyId = "cohesionism";
  s.subject.politics!.support.set("cohesionism", 90);
  const districts = [...getOwnerByMesoId(s.world)].filter(([, owner]) => owner === s.subject.id).map(([id]) => id);
  assert(!transferTerritories(s.world, [{ from: s.subject.id, to: s.overlord.id, regionIds: districts }], "integration"));
  s.at(200);
  assert.equal(s.subject.subjectDecision?.status, "proposed");
  s.at(210);
  assert.equal(s.subject.subjectDecision?.status, "rejected");
  assert.equal(s.subject.subjectGovernment, s.government);
  for (let tick = 220; tick <= 410; tick += 10) s.at(tick);
  assert.equal(s.subject.subjectDecision?.status, "rejected");
  assert.equal(s.world.events?.filter(({ message }) => message.includes("integration (proposed)")).length, 1);
});

test("a loyal culturally different subject can ratify integration with asset and ownership conservation", () => {
  function run() {
    const s = scene();
    s.relation.trust = 95;
    s.subject.politics!.system = "monarchy";
    s.subject.politics!.governingIdeologyId = "capitalism";
    s.subject.politics!.support.set("capitalism", 40);
    // A smaller field army makes coordinated security more attractive to the subject.
    const fieldUnit = createFixedSocietyWorld().units[0]!;
    s.world.units = [{ ...fieldUnit, nationId: s.overlord.id, regionId: s.overlord.capitalMesoId }];
    const stock = s.subject.resources.steel + s.overlord.resources.steel;
    const capital = s.subject.capitalMesoId;
    s.at(200);
    assert.equal(s.subject.subjectDecision?.status, "proposed");
    assert(s.subject.subjectGovernment && getSubjectIntegrationIssue(s.world, s.overlord.id, s.subject.id));
    s.at(210);
    assert.equal(s.subject.subjectDecision?.status, "agreed");
    assert.equal(s.subject.subjectGovernment, undefined);
    assert.equal(s.subject.macroRegionIds.length, 0);
    assert.equal(getOwnerByMesoId(s.world).get(capital), s.overlord.id);
    assert.equal(s.overlord.resources.steel, stock);
    assert.equal(s.subject.resources.steel, 0);
    return worldSignature(s.world);
  }
  assert.equal(run(), run());
});

test("integration ratification rechecks wartime eligibility", () => {
  const s = scene();
  s.subject.governance!.alignment = 1;
  s.relation.trust = 90;
  s.at(200);
  assert.equal(s.subject.subjectDecision?.status, "proposed");
  declareWar(s.world.wars, s.overlord.id, s.third.id, s.world.time.fastTick);
  s.at(210);
  assert.equal(s.subject.subjectDecision?.status, "rejected");
  assert.match(s.subject.subjectDecision!.reason, /War or occupation/);
  assert.equal(s.subject.subjectGovernment, s.government);
});

test("a weakened belligerent overlord can negotiate independence with a truce", () => {
  const s = scene();
  s.overlord.warCooperation = 0.15;
  s.government.autonomy = 100;
  declareWar(s.world.wars, s.overlord.id, s.third.id, 0);
  const politics = s.subject.politics;
  const resources = { ...s.subject.resources };
  s.at(30);
  assert.equal(s.subject.subjectDecision?.issue, "independence");
  assert.equal(s.subject.subjectGovernment, s.government);
  s.at(40);
  assert.equal(s.subject.subjectDecision?.status, "agreed");
  assert.equal(s.subject.subjectGovernment, undefined);
  assert.equal(s.subject.politics, politics);
  assert.deepEqual(s.subject.resources, resources);
  assert(hasTreaty(s.world, s.overlord.id, s.subject.id, "truce"));
  assert.equal(s.world.wars.length, 1);
});

test("a stronger subject can break away after a rejection without necessarily starting a war", () => {
  const s = scene();
  s.government.autonomy = 100;
  s.relation.trust = 20;
  s.overlord.warCooperation = 0.85;
  s.at(30);
  assert.equal(s.subject.subjectGovernment, s.government);
  s.at(40);
  assert.equal(s.subject.subjectDecision?.status, "counteroffer");
  s.at(50);
  assert.equal(s.subject.subjectDecision?.status, "unilateral");
  assert.equal(s.subject.subjectGovernment, undefined);
  assert.equal(s.world.wars.length, 0);
});

test("failed independence talks lower trust and do not force separation under an active truce", () => {
  const s = scene();
  s.government.autonomy = 100;
  s.relation.trust = 20;
  s.relation.treaties.push({ type: "truce", expiresAtSlowTick: 500 });
  s.at(30);
  s.at(40);
  assert.equal(s.subject.subjectDecision?.status, "counteroffer");
  s.at(50);
  assert.equal(s.subject.subjectDecision?.status, "rejected");
  assert.equal(s.subject.subjectGovernment, s.government);
  assert(s.relation.trust < 20);
  assert.equal(s.world.wars.length, 0);
  s.at(60);
  assert.equal(s.subject.subjectDecision?.status, "rejected");
  s.at(500);
  assert.equal(s.subject.subjectDecision?.status, "proposed");
});

test("autonomy concessions reduce real harvest obligations and constrain future interference", () => {
  const s = scene();
  s.overlord.character!.aggression = 0.4;
  s.overlord.character!.cooperation = 0.9;
  s.government.autonomy = 54;
  assert(setSubjectFoodLevy(s.world, s.overlord.id, s.subject.id, 0.50));
  s.subject.food!.levy = -1;
  s.at(30);
  assert.equal(s.subject.subjectDecision?.issue, "self-government");
  s.at(40);
  assert.equal(s.subject.subjectDecision?.status, "agreed");
  assert.equal(s.government.foodLevy, 0.30);
  assert.equal(s.government.selfGovernment?.maximumLevy, 0.30);
  assert(!setGovernancePolicy(s.world, s.overlord.id, s.subject.id, "assimilation"));
  assert(setGovernancePolicy(s.world, s.subject.id, s.subject.id, "assimilation"));
  assert(setSubjectFoodLevy(s.world, s.overlord.id, s.subject.id, 0.50));
  s.at(50);
  assert.equal(s.subject.subjectDecision?.status, "violated");
  assert.equal(s.government.selfGovernment, undefined);
});


test("a militarily stronger overlord can intervene after a unilateral break", () => {
  const s = scene();
  const [first, second, third] = createFixedSocietyWorld().units;
  s.world.units = [
    { ...first, nationId: s.overlord.id, regionId: s.overlord.capitalMesoId },
    { ...first, id: second.id, nationId: s.overlord.id, regionId: s.overlord.capitalMesoId },
    { ...first, id: third.id, nationId: s.subject.id, regionId: s.subject.capitalMesoId },
  ];
  s.government.autonomy = 100;
  s.subject.identityStability!.grievance = 0.26;
  s.relation.trust = 20;
  s.at(30);
  s.at(40);
  s.at(50);
  assert.equal(s.subject.subjectDecision?.status, "unilateral");
  assert.equal(findWar(s.world.wars, s.overlord.id, s.subject.id)?.aggressorId, s.overlord.id);
});

test("a negotiated industrial aid increase conserves stock and obeys the donor reserve", () => {
  const s = scene();
  s.overlord.character!.cooperation = 0.95;
  s.overlord.character!.aggression = 0.35;
  s.government.autonomy = 49;
  s.subject.resources.steel = 0;
  s.overlord.resources.steel = 50;
  updateSupplyAssessment(s.world);
  s.at(30);
  s.at(40);
  assert(s.government.selfGovernment?.extraIndustrialAid);
  assert.equal(s.subject.resources.steel, 6);
  s.at(50);
  assert.equal(s.subject.resources.steel, 11);
  assert.equal(s.overlord.resources.steel, 39);
});
