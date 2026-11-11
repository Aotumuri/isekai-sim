import test from "node:test";
import assert from "node:assert/strict";
import { retainedRetargetProgress, type MovementLeg } from "../../src/sim/nation/movement-continuity";

const leg = { regionId: "a", moveFromId: "a", moveToId: "b",
  moveTargetId: "c", moveProgressMs: 700 } as MovementLeg;
test("retargeting beyond the same next edge retains already traveled progress", () => {
  const next = { ...leg, moveTargetId: "d", moveProgressMs: 100 } as MovementLeg;
  assert.equal(retainedRetargetProgress(next, leg, 100), 800);
  assert.equal(retainedRetargetProgress({ ...next, moveProgressMs: 800 }, leg, 100), 800);
});
test("different edges, stopped orders and teleports cannot reuse travel", () => {
  for (const patch of [{ moveToId: "e" }, { regionId: "e" }, { moveFromId: null },
    { moveToId: null }, { moveTargetId: null }, { moveTargetId: "c" }]) {
    const next = { ...leg, moveProgressMs: 100, moveTargetId: "d", ...patch } as MovementLeg;
    assert.equal(retainedRetargetProgress(next, leg, 100), 100);
  }
});
