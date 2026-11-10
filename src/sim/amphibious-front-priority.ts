import { getNationFrontAllocations } from "./nation-front-allocations";
import { getUnitCombatStrength } from "./unit-strength";
import type { UnitState } from "./unit";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export function getExpeditionCandidates(
  world: WorldState, nationId: NationId, units: readonly UnitState[],
): UnitState[] {
  const availableStrength = new Map(
    getNationFrontAllocations(world, nationId).map((front) => [front.frontId, front.surplus]),
  );
  const fronts = world.frontAllocations.frontIdByUnitId;
  return units.filter((unit) => {
    const front = fronts.get(unit.id);
    if (!front) return true;
    const surplus = availableStrength.get(front) ?? 0;
    const strength = getUnitCombatStrength(unit);
    if (strength > surplus + 1e-6) return false;
    availableStrength.set(front, surplus - strength);
    return true;
  });
}
