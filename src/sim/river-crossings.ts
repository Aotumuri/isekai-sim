import type { MesoRegion } from "../worldgen/meso-region";
import type { UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";

/** An organized garrison can contest a river crossing. */
export function getRiverCrossingPressure(target: MesoRegion | undefined,
  attackers: readonly UnitState[], defenders: readonly UnitState[],
): number {
  if (!defenders.some((unit) => !unit.moveTargetId && unit.org >= 0.7 && unit.manpower > 0)) return 1;
  const riverBanks = new Set(target?.neighbors.filter((edge) => edge.hasRiver).map((edge) => edge.id));
  if (!riverBanks.size) return 1;
  let total = 0;
  let crossing = 0;
  for (const unit of attackers) {
    if (unit.org <= 0 || unit.manpower <= 0 || unit.moveToId !== target?.id) continue;
    const strength = getUnitCombatStrength(unit);
    total += strength;
    if (riverBanks.has(unit.moveFromId ?? unit.regionId)) crossing += strength;
  }
  return total > 0 ? 1 + 0.25 * crossing / total : 1;
}
