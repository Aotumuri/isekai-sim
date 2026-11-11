import test from "node:test";
import assert from "node:assert/strict";
import { pairedBootstrap } from "../helpers/paired-bootstrap";
test("paired bootstrap preserves fixed deltas and does not consume simulation randomness", () => {
  assert.deepEqual(pairedBootstrap([2, 2, 2]), { meanDelta: 2, lower95: 2, upper95: 2, n: 3, resamples: 10000 });
  const values = [-1, 0, 1, 2];
  assert.deepEqual(pairedBootstrap(values), pairedBootstrap(values));
  assert.ok(pairedBootstrap(values).lower95 < 0.5);
  assert.ok(pairedBootstrap(values).upper95 > 0.5);
  assert.throws(() => pairedBootstrap([]));
});
