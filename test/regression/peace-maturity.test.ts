import assert from "node:assert/strict";
import test from "node:test";
import { isPeaceNegotiationMature } from "../../src/sim/peace-maturity";

const cases = [
  { age: 299, blows: true, urgency: 1, mature: false },
  { age: 300, blows: false, urgency: 0, mature: false },
  { age: 300, blows: true, urgency: 0, mature: true },
  { age: 300, blows: false, urgency: 0.79, mature: false },
  { age: 300, blows: false, urgency: 0.8, mature: true },
  { age: 899, blows: false, urgency: 0, mature: false },
  { age: 900, blows: false, urgency: 0, mature: true },
];

for (const { age, blows, urgency, mature } of cases) {
  test(`peace maturity at ${age} days with exchanged blows ${blows} and urgency ${urgency}`, () => {
    assert.equal(isPeaceNegotiationMature(age, blows, urgency), mature);
  });
}
