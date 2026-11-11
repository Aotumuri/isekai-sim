import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCampaignAlternatives, selectCampaignMilitaryEffort, type CampaignOpportunity } from "../../src/sim/war-campaign/alternatives";
const opportunity = {
  opponentId: "enemy", availableStrength: 2000, opposition: 1000, arrivalSeconds: 1,
  objectiveValue: 0.3, securedValue: 0, homelandAtRisk: 0, lossFractionPerSecond: 0,
  replacementFraction: 0, peaceProbability: 0, settlementValue: 0,
  militaryGoalHeld: false, uncertainty: 0.2, committedFraction: 0,
} as CampaignOpportunity;
test("alternatives distinguish a reachable valuable objective from an inaccessible one", () => {
  const reachable = evaluateCampaignAlternatives([opportunity], 0.6);
  assert.equal(reachable[0].mode, "limited-offensive");
  assert.equal(evaluateCampaignAlternatives([{ ...opportunity, arrivalSeconds: Infinity }], 0.6)[0].mode, "defend");
  assert.deepEqual(reachable, evaluateCampaignAlternatives([opportunity], 0.6));
});
test("a held military goal is insufficient for consolidation without final settlement value", () => {
  const foothold = { ...opportunity, militaryGoalHeld: true, objectiveValue: 0,
    peaceProbability: 0.9, lossFractionPerSecond: 0.005 };
  assert.equal(evaluateCampaignAlternatives([foothold], 0.6)[0].mode, "seek-peace");
  assert.equal(evaluateCampaignAlternatives([{ ...foothold, settlementValue: 0.2 }], 0.6)[0].mode, "consolidate");
});
test("continuing costs and reachable benefit select priority rather than smallest enemy", () => {
  const lowValue = { ...opportunity, opponentId: "weak", opposition: 500, objectiveValue: 0.001 } as CampaignOpportunity;
  assert.equal(evaluateCampaignAlternatives([lowValue, opportunity], 0.6)[0].opponentId, "enemy");
  const exhausted = { ...opportunity, lossFractionPerSecond: 0.02, peaceProbability: 1, settlementValue: 0.1 };
  assert.equal(evaluateCampaignAlternatives([exhausted], 0.6)[0].mode, "seek-peace");
});
test("travel and committed force impose a finite, evidence-dependent change cost", () => {
  const input = { ...opportunity, arrivalSeconds: 10, committedFraction: 0.8 };
  const current = { mode: "defend", primaryOpponentId: input.opponentId } as const;
  const options = evaluateCampaignAlternatives([input], 0.6, current);
  assert.ok(options.find((o) => o.mode === "limited-offensive")!.changeCost > 0);
  assert.equal(options.find((o) => o.mode === "defend")!.changeCost, 0);
  assert.equal(options[0].mode, "limited-offensive");
});

test("seeking an agreement retains a military fallback and does not charge for changing a nonexistent military order", () => {
  const input = { ...opportunity, arrivalSeconds: 10, committedFraction: 1, peaceProbability: 0.2, settlementValue: 0.2 };
  const options = evaluateCampaignAlternatives([input], 0.6,
    { mode: "seek-peace", militaryMode: "limited-offensive", primaryOpponentId: input.opponentId });
  assert.equal(options.find((o) => o.mode === "limited-offensive")!.changeCost, 0);
  assert.equal(options.find((o) => o.mode === "seek-peace")!.changeCost, 0);
  assert.equal(selectCampaignMilitaryEffort(options, "seek-peace", false).mode, "limited-offensive");
  assert.equal(selectCampaignMilitaryEffort(options, "seek-peace", true).mode, "defend");
});
