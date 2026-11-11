import type { UnitState } from "../unit";

export type MovementLeg = Pick<UnitState,
  "regionId" | "moveTargetId" | "moveFromId" | "moveToId" | "moveProgressMs">;

/** A changed distant objective need not discard travel on the same valid edge.
 * Called only after routing has resolved the new order's first edge. */
export function retainedRetargetProgress(unit: MovementLeg, previous: MovementLeg | undefined, dtMs: number): number {
  if (!previous || !unit.moveTargetId || previous.moveTargetId === unit.moveTargetId ||
    !previous.moveToId || previous.moveFromId !== previous.regionId ||
    previous.regionId !== unit.regionId || unit.moveFromId !== previous.moveFromId ||
    unit.moveToId !== previous.moveToId) return unit.moveProgressMs;
  return Math.max(unit.moveProgressMs, previous.moveProgressMs + dtMs);
}
