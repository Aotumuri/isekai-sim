import assert from "node:assert/strict";
import test from "node:test";
import { hasMinimumPeaceAge, isPeaceNegotiationMature } from "../../src/sim/peace-maturity";

test("peace maturity protects the minimum age and requires evidence until the later deadline", () => {
  const cases = [
    { age: 29.9, blows: true, urgency: 1, mature: false },
    { age: 30, blows: false, urgency: 0, mature: false },
    { age: 30, blows: true, urgency: 0, mature: true },
    { age: 30, blows: false, urgency: 0.79, mature: false },
    { age: 30, blows: false, urgency: 0.8, mature: true },
    { age: 89.9, blows: false, urgency: 0, mature: false },
    { age: 90, blows: false, urgency: 0, mature: true },
  ];
  for (const { age, blows, urgency, mature } of cases) {
    assert.equal(isPeaceNegotiationMature(age, blows, urgency), mature);
  }
  assert.equal(hasMinimumPeaceAge(499, 200), false);
  assert.equal(hasMinimumPeaceAge(500, 200), true);
});
