import assert from "node:assert/strict";
import test from "node:test";
import { getInfluence, getRelation, updateDiplomaticRelations } from "../../src/sim/diplomacy";
import { createFaction, joinFaction } from "../../src/sim/factions";
import { getNationIdeology } from "../../src/sim/nation-identity";
import { ADVOCACY_INFLUENCE_REQUIRED, inspectAdvocacyCandidate, POLITICAL_ADVOCACY_COST } from "../../src/sim/political-advocacy";
import { getPoliticalContacts } from "../../src/sim/political-influence";
import { openRegionalNegotiation } from "../../src/sim/regional-negotiations";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { declareWar } from "../../src/sim/war-state";
import { observeAdvocacyReassessment, type ReassessmentStrategy } from "../diagnostics/observe-advocacy-reassessment";
import { worldSignature } from "../diagnostics/world-signature";
import { fixedSocietyDistrict } from "../helpers/fixed-society-world";
import { commitCount, district, openDemand, openDemands, scene, screenAt, sponsorFinance } from "../helpers/foreign-advocacy-fixture";

function setup(strategy?: ReassessmentStrategy, cooperation = 0.49) {
  const s = scene({ cooperation });
  const talks = openDemand(s);
  for (const { id } of s.world.nations) sponsorFinance(s.world, id, 0);
  const relation = getRelation(s.world, s.sponsor.id, s.target.id);
  relation.trust = 60;
  const audit = strategy && observeAdvocacyReassessment(s.world, strategy);
  if (audit) s.world.instrumentation = { ...audit.instrumentation, recordDuration() {}, incrementCounter() {} };
  return { ...s, demand: talks, relation, audit };
}

function finance(s: ReturnType<typeof setup>, amount: number) {
  sponsorFinance(s.world, s.sponsor.id, amount);
}

test("influence regeneration opens a real opportunity only in time for threshold reassessment", () => {
  for (const strategy of ["initial", "threshold", "fallback"] as const) {
    const s = setup(strategy, 0.51);
    finance(s, ADVOCACY_INFLUENCE_REQUIRED - 3);
    screenAt(s, 301);
    assert.equal(s.demand.foreign, undefined);
    // Isolate regeneration from treaty spending later in the same update.
    s.world.settings!.tradeEnabled = false;
    for (const { id } of s.world.nations) {
      if (id !== s.sponsor.id) getRelation(s.world, s.sponsor.id, id).opinion = -20;
    }
    updateDiplomaticRelations(s.world);
    assert.equal(getInfluence(s.world, s.sponsor.id), ADVOCACY_INFLUENCE_REQUIRED);
    screenAt(s, 302);
    s.at(310);
    const threshold = strategy === "threshold";
    assert.equal(s.talks()?.foreign?.sponsorId, threshold ? s.sponsor.id : undefined, strategy);
    assert.equal(s.demand.offer, threshold ? "autonomous" : "protected", strategy);
    assert.equal(s.audit!.summarize().decisionsChanged, Number(threshold));
    // The fallback can still see a long-lived, partial domestic offer.
    screenAt(s, 311);
    assert.equal(s.audit!.summarize().proposals, strategy === "initial" ? 0 : 1, strategy);
  }
});

test("all currently binding reasons remain visible when influence never recovers in time", () => {
  const s = setup("threshold");
  finance(s, 20);
  s.sponsor.politics!.nextForeignAdvocacyAt = 330;
  screenAt(s, 301);
  screenAt(s, 302);
  assert.equal(s.audit!.summarize().initialPrimary.cooldown, 1);
  assert.ok(s.audit!.summarize().initialAny.influence! >= 1);
  assert.equal(s.audit!.summarize().selectedDistricts, 0);
  assert.equal(getInfluence(s.world, s.sponsor.id), 20);
  s.at(310);
  s.at(320);
  screenAt(s, 380);
  assert.ok(s.audit!.summarize().influenceStillInsufficient > 0);
  assert.equal(s.demand.foreign, undefined);
});

test("late influence recovery is counted after closure and cannot spend", () => {
  const s = setup("threshold", 0.9);
  finance(s, ADVOCACY_INFLUENCE_REQUIRED - 1);
  screenAt(s, 301);
  s.at(310);
  s.at(320);
  assert.equal(s.demand.status, "agreed");
  finance(s, 90);
  screenAt(s, 321);
  assert.equal(s.audit!.summarize().influenceRecoveredAfter, 1);
  assert.equal(s.audit!.summarize().proposals, 0);
  assert.equal(getInfluence(s.world, s.sponsor.id), 90);
});

test("a new trade treaty discovers a qualifying contact, while an expired treaty cannot", () => {
  for (const strategy of ["threshold", "fallback"] as const) {
    const s = setup(strategy);
    const fourth = s.fourth;
    assert.ok(!getPoliticalContacts(s.world).get(s.target.id)?.has(fourth.id));
    fourth.identityGovernment!.favored.culture = "tide-guilds";
    sponsorFinance(s.world, fourth.id, 90);
    const relation = getRelation(s.world, fourth.id, s.target.id);
    relation.trust = 90;
    screenAt(s, 301);
    relation.treaties.push({ type: "trade", expiresAtSlowTick: 304 });
    for (const tick of [302, 303, 304, 311]) screenAt(s, tick);
    assert.equal(s.talks()?.foreign?.sponsorId, strategy === "threshold" ? fourth.id : undefined);
    assert.equal(s.audit!.summarize().firstGainedContacts, strategy === "threshold" ? 1 : 0);
    assert.equal(s.audit!.summarize().newContactSources.trade ?? 0, strategy === "threshold" ? 1 : 0);
    assert.equal(s.audit!.summarize().proposals, strategy === "threshold" ? 1 : 0);
  }
});

for (const source of ["border", "faction", "alliance"] as const) {
  test(`new ${source} contact is discovered while sponsor interest remains independent`, () => {
    const s = setup("threshold");
    const { fourth } = s;
    assert.ok(!getPoliticalContacts(s.world).get(s.target.id)?.has(fourth.id));
    sponsorFinance(s.world, fourth.id, 90);
    const relation = getRelation(s.world, fourth.id, s.target.id);
    relation.opinion = 60;
    relation.trust = 90;
    if (source !== "alliance") fourth.identityGovernment!.favored.culture = "tide-guilds";
    else {
      fourth.character = { doctrine: "merchant", aggression: 0, cooperation: 1, innovation: 0.5, thrift: 0.5 };
      fourth.ideologyId = s.target.ideologyId;
      fourth.identityGovernment!.favored.culture = "reed-courts";
    }
    screenAt(s, 301);
    if (source === "border") {
      assert.ok(transferTerritories(s.world, [{ from: s.target.id, to: fourth.id, regionIds: [fixedSocietyDistrict(4, 1)] }]));
    }
    if (source === "faction") {
      sponsorFinance(s.world, s.target.id, 20);
      const faction = createFaction(s.world, s.target.id, {
        allowedIdeologyIds: [getNationIdeology(s.world, s.target.id).id, getNationIdeology(s.world, fourth.id).id],
        defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: true,
      });
      assert.ok(faction && joinFaction(s.world, fourth.id, faction.id));
    }
    if (source === "alliance") relation.treaties.push({ type: "alliance", expiresAtSlowTick: 400 });
    screenAt(s, 302);
    assert.equal(s.audit!.summarize().newContactSources[source], 1);
    assert.equal(s.talks()?.foreign?.sponsorId, source === "alliance" ? undefined : fourth.id);
  });
}

for (const blocker of ["war", "crisis", "cooldown", "subjectRelationship"] as const) {
  test(`reassessment respects ${blocker} until it clears`, () => {
    const s = setup("threshold");
    if (blocker === "war") assert.ok(declareWar(s.world.wars, s.sponsor.id, s.target.id, 3000));
    if (blocker === "crisis") s.relation.crisis = {
      aggressorId: s.sponsor.id, openedAtSlowTick: 300, deadlineSlowTick: 305, demand: "containment",
    };
    if (blocker === "cooldown") s.sponsor.politics!.nextForeignAdvocacyAt = 305;
    if (blocker === "subjectRelationship") {
      s.sponsor.subjectGovernment = { overlordId: s.target.id, establishedAtFastTick: 3000 };
    }
    screenAt(s, 301);
    finance(s, 90);
    screenAt(s, 302);
    assert.equal(s.demand.foreign, undefined);
    assert.equal(s.audit!.summarize().selectedDistricts, 0);
    assert.equal(getInfluence(s.world, s.sponsor.id), 90);
    s.world.wars.length = 0;
    s.relation.crisis = null;
    delete s.sponsor.subjectGovernment;
    screenAt(s, 305);
    assert.equal(s.talks()?.foreign?.sponsorId, s.sponsor.id);
    assert.equal(getInfluence(s.world, s.sponsor.id), 90 - POLITICAL_ADVOCACY_COST);
  });
}

test("interest threshold crossing matters and small score fluctuations do not schedule repeated proposals", () => {
  const s = setup("threshold");
  finance(s, 90);
  s.sponsor.character = { doctrine: "merchant", aggression: 0, cooperation: 1, innovation: 0.5, thrift: 0.5 };
  s.sponsor.ideologyId = s.target.ideologyId;
  s.sponsor.identityGovernment!.favored.culture = "reed-courts";
  s.relation.opinion = 0;
  screenAt(s, 301);
  assert.equal(s.audit!.summarize().initialAny.interest! > 0, true);
  for (let tick = 302; tick < 307; tick++) {
    s.relation.opinion -= 0.1;
    screenAt(s, tick);
  }
  assert.equal(s.audit!.summarize().selectedDistricts, 0);
  s.sponsor.identityGovernment!.favored.culture = "tide-guilds";
  screenAt(s, 307);
  assert.equal(s.demand.foreign?.sponsorId, s.sponsor.id);
  screenAt(s, 308);
  assert.equal(s.audit!.summarize().proposals, 1);
  assert.equal(s.audit!.summarize().scoreFactors.kinship, 1);
});

test("a credible domestic offer can still make newly affordable backing undesirable", () => {
  const s = setup("threshold", 0.9);
  screenAt(s, 301);
  s.at(310);
  assert.equal(s.demand.offer, s.demand.requested);
  finance(s, 90);
  screenAt(s, 311);
  assert.equal(s.demand.foreign, undefined);
  assert.equal(s.audit!.summarize().domesticRefusals, 1);
  const after = getInfluence(s.world, s.sponsor.id);
  s.relation.opinion -= 20;
  screenAt(s, 312);
  assert.equal(getInfluence(s.world, s.sponsor.id), after);
  assert.equal(s.audit!.summarize().proposals, 1);
  assert.equal(s.demand.foreignRefusals?.[s.sponsor.id], 611);
});

for (const invalidation of ["replaced", "transferred", "sponsor extinct", "target extinct", "settled", "backed"] as const) {
  test(`stale opportunities are discarded when the case is ${invalidation}`, () => {
    const s = setup("threshold");
    screenAt(s, 301);
    finance(s, 90);
    if (invalidation === "replaced") {
      // Same district and owner, different generation. No new demand was queued.
      s.world.regionalNegotiations!.set(district, { ...s.demand, group: 2 });
    }
    if (invalidation === "transferred") {
      assert.ok(transferTerritories(s.world, [{ from: s.target.id, to: s.rival.id, regionIds: [district] }]));
    }
    if (invalidation === "sponsor extinct") s.sponsor.macroRegionIds = [];
    if (invalidation === "target extinct") s.target.macroRegionIds = [];
    if (invalidation === "settled") s.demand.status = "agreed";
    if (invalidation === "backed") {
      s.demand.foreign = { sponsorId: s.rival.id, since: 301, renewAt: 461, strength: 0.5, backlash: 0 };
    }
    screenAt(s, 302);
    assert.equal(s.audit!.summarize().proposals, 0);
    assert.equal(getInfluence(s.world, s.sponsor.id), 90);
    assert.equal(s.demand.foreign?.sponsorId, invalidation === "backed" ? s.rival.id : undefined);
  });
}

test("a replacement gets its own initial screening, independent of the old observation", () => {
  const s = setup("threshold");
  screenAt(s, 301);
  openRegionalNegotiation(s.world, s.target, district, s.demand);
  finance(s, 90);
  screenAt(s, 302);
  assert.equal(s.demand.foreign, undefined);
  assert.equal(s.talks()!.foreign?.sponsorId, s.sponsor.id);
  assert.equal(s.audit!.summarize().initialScreenings, 2);
  assert.equal(s.audit!.summarize().proposals, 0);
});

test("multiple simultaneous opportunities enforce sponsor cooldown and capacity deterministically", () => {
  const districts = [fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1), fixedSocietyDistrict(4, 1)];
  function run(reverse: boolean) {
    const s = setup("threshold");
    openDemands(s, reverse ? [...districts].reverse() : districts);
    s.world.regionalNegotiations!.get(districts[0]!)!.foreign = {
      sponsorId: s.sponsor.id, since: 300, renewAt: 460, strength: 0.5, backlash: 0,
    };
    screenAt(s, 301);
    finance(s, 90);
    screenAt(s, 302);
    assert.equal(commitCount(s), 2);
    assert.equal(s.audit!.summarize().proposals, 1);
    assert.equal(getInfluence(s.world, s.sponsor.id), 68);
    return districts.map((id) => s.world.regionalNegotiations!.get(id)!.foreign?.sponsorId);
  }
  assert.deepEqual(run(false), run(true));
});

test("reassessment cannot spend unavailable influence after an earlier refused offer in the same cycle", () => {
  const s = setup("threshold");
  const [domestic, other] = openDemands(s, [fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1)]);
  domestic.status = "offer";
  domestic.offer = domestic.requested;
  screenAt(s, 301);
  finance(s, ADVOCACY_INFLUENCE_REQUIRED);
  screenAt(s, 302);
  assert.equal(s.audit!.summarize().domesticRefusals, 1);
  assert.equal(s.audit!.summarize().proposals, 1);
  assert.equal(other.foreign, undefined);
  assert.equal(getInfluence(s.world, s.sponsor.id), ADVOCACY_INFLUENCE_REQUIRED - POLITICAL_ADVOCACY_COST);
});

test("competing sponsors use movement preferences and only one spends", () => {
  const s = setup("threshold");
  s.rival.identityGovernment!.favored.culture = "tide-guilds";
  getRelation(s.world, s.target.id, s.rival.id).trust = 40;
  screenAt(s, 301);
  finance(s, 90);
  sponsorFinance(s.world, s.rival.id, 90);
  screenAt(s, 302);
  assert.equal(s.audit!.summarize().selectionCandidates, 2);
  assert.equal(s.audit!.summarize().proposals, 1);
  const spent = (90 - getInfluence(s.world, s.rival.id)) + (90 - getInfluence(s.world, s.sponsor.id));
  assert.equal(spent, POLITICAL_ADVOCACY_COST);
});

test("candidate inspection never initializes live diplomacy, identity, character or claims", () => {
  const s = setup();
  delete s.world.diplomacy;
  delete s.world.territorialClaims;
  delete s.sponsor.character;
  delete s.sponsor.ideologyId;
  const before = worldSignature(s.world);
  const state = inspectAdvocacyCandidate(s.world, district, s.demand, s.target, s.sponsor, new Map());
  assert.equal(state.influence, 30);
  assert.equal(worldSignature(s.world), before);
});

test("audit-only instrumentation preserves the whole deterministic world and RNG state", () => {
  const run = (strategy?: ReassessmentStrategy) => {
    const s = setup(strategy);
    finance(s, ADVOCACY_INFLUENCE_REQUIRED - 1);
    screenAt(s, 301);
    finance(s, 90);
    screenAt(s, 302);
    s.at(310);
    screenAt(s, 311);
    s.at(320);
    return worldSignature(s.world);
  };
  assert.equal(run(), run("initial"));
  assert.equal(run("threshold"), run("threshold"));
  assert.notEqual(run("initial"), run("threshold"));
});
