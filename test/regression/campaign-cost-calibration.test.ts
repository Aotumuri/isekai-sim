import test from "node:test";
import assert from "node:assert/strict";
import { classifyCampaignCostWindow, type CampaignCostWindowPoint } from "../helpers/campaign-cost-window";

function point(overrides: Partial<CampaignCostWindowPoint> = {}): CampaignCostWindowPoint {
  return { openingWarKey: "nation-0:nation-1@0", planPresent: true, objectivePresent: true,
    openingWarActive: true, activeWarMembershipKey: "nation-0:nation-1@0",
    campaignMembershipKey: "nation-0:nation-1@0", openingDenominator: 100,
    militaryMode: "defend", primaryOpponentId: "nation-1",
    observation: { tick: 100, casualtyFraction: 0.2, lossRate: 0.01 }, ...overrides };
}
const stableWindow = () => Array.from({ length: 30 }, (_, index) =>
  point({ observation: { tick: 110 + index * 10, casualtyFraction: 0.2, lossRate: 0.01 } }));

test("stable campaign window is eligible and compares observed future loss", () => {
  const result = classifyCampaignCostWindow(point(),
    point({ observation: { tick: 400, casualtyFraction: 0.27, lossRate: 0.01 } }), stableWindow());
  assert.equal(result.eligible, true);
  assert.equal(result.predictedLossFractionFromObservedRate, 0.3);
  assert.ok(Math.abs(result.actualCasualtyFractionIncrease! - 0.07) < 1e-12);
  assert.deepEqual(result.censorReasons, []);
});

test("military mode A to B to A is censored from intermediate observations", () => {
  const during = stableWindow();
  during[14] = point({ observation: { tick: 250, casualtyFraction: 0.2, lossRate: 0.01 },
    militaryMode: "limited-offensive" });
  const result = classifyCampaignCostWindow(point(), point(), during);
  assert.equal(result.eligible, false);
  assert.ok(result.censorReasons.includes("military-mode-changed"));
});

test("denominator and war membership changes inside the window are distinct", () => {
  const denominatorWindow = stableWindow();
  denominatorWindow[5] = point({ openingDenominator: 120 });
  const membershipWindow = stableWindow();
  membershipWindow[8] = point({ activeWarMembershipKey: "nation-0:nation-1@0|nation-0:nation-2@0",
    campaignMembershipKey: "nation-0:nation-1@0|nation-0:nation-2@0" });
  assert.ok(classifyCampaignCostWindow(point(), point(), denominatorWindow).censorReasons
    .includes("opening-denominator-changed"));
  assert.ok(classifyCampaignCostWindow(point(), point(), membershipWindow).censorReasons
    .includes("war-membership-changed"));
});

test("ended wars and missing futures stay censored without zero observed damage", () => {
  const ended = classifyCampaignCostWindow(point(), point({ openingWarActive: false,
    planPresent: false, objectivePresent: false, observation: null }), stableWindow());
  assert.equal(ended.eligible, false);
  assert.equal(ended.actualCasualtyFractionIncrease, null);
  assert.equal(ended.predictedLossFractionFromObservedRate, 0.3);
  assert.ok(ended.censorReasons.includes("opening-war-ended-before-future"));

  const missing = classifyCampaignCostWindow(point(), null, stableWindow());
  assert.equal(missing.actualCasualtyFractionIncrease, null);
  assert.equal(missing.predictedLossFractionFromObservedRate, 0.3);
  assert.ok(missing.censorReasons.includes("future-observation-missing"));
});
