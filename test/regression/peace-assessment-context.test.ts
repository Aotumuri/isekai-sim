import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { assessPeaceOffer, getWarNegotiation, whitePeaceTerms, type PeaceTerms } from "../../src/sim/war-negotiations";
import { createPeaceAssessmentContext } from "../../src/sim/peace-assessment-context";

test("sharing immutable peace facts preserves every legal and illegal offer assessment", () => {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, width: 640, height: 360, quick: true });
  world.settings!.diplomacyEnabled = true;
  const war = world.wars[0]; war.isTest = false;
  world.time.fastTick = 1000; world.time.slowTick = 100;
  getWarNegotiation(world, war);
  for (const nation of world.nations) nation.resources.weapons = 100;
  const context = createPeaceAssessmentContext();
  const terms: PeaceTerms[] = [whitePeaceTerms(),
    { ...whitePeaceTerms(), demandedWeapons: 10 }, { ...whitePeaceTerms(), offeredWeapons: 20 },
    { ...whitePeaceTerms(), demandedWeapons: 101 }, { ...whitePeaceTerms(), truceSeconds: 600 },
    { ...whitePeaceTerms(), puppetTarget: true }];
  for (const [recipient, proposer] of [[war.nationAId, war.nationBId], [war.nationBId, war.nationAId]]) {
    for (const offer of terms) {
      assert.deepEqual(assessPeaceOffer(world, recipient, proposer, offer, context),
        assessPeaceOffer(world, recipient, proposer, offer));
    }
  }
  assert.ok(context.power.size > 0);
  assert.ok(context.territorialValue.size > 0);
  // Different non-territorial offers and both recipients share one unchanged
  // final-border check; affordability and all other checks remain per offer.
  assert.equal(context.borderIssue.size, 1);
  // The next evaluation creates its own context, rather than hiding changes.
  world.nations.find((nation) => nation.id === war.nationAId)!.food = {
    stock: 0, harvest: 0, demand: 100, rationCoverage: 0, shortageCycles: 10, deaths: 0,
  };
  const fresh = createPeaceAssessmentContext();
  assert.deepEqual(assessPeaceOffer(world, war.nationAId, war.nationBId, terms[0], fresh),
    assessPeaceOffer(world, war.nationAId, war.nationBId, terms[0]));
});
