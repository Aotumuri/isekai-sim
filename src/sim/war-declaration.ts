import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import type { UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getAdjacentNationPairs } from "./world-cache";
import { nextScheduledTickRange } from "./schedule";
import { buildWarAdjacency, declareWar, isAtWar } from "./war-state";

export function updateWarDeclarations(world: WorldState): void {
  const declareBalance = WORLD_BALANCE.war.declare;
  const declareRange = declareBalance.slowTickRange;
  if (declareRange.min <= 0 || declareRange.max <= 0) {
    return;
  }
  if (world.time.slowTick < world.nextWarDeclarationTick) {
    return;
  }
  world.nextWarDeclarationTick = nextScheduledTickRange(
    world.time.slowTick,
    declareRange.min,
    declareRange.max,
    world.simRng,
  );
  if (world.nations.length < 2) {
    return;
  }

  const adjacentPairs = getAdjacentNationPairs(world);
  if (adjacentPairs.length === 0) {
    return;
  }

  const unitCounts = collectUnitCountsByNation(world.units);
  const warAdjacency = buildWarAdjacency(world.wars);
  const candidates: Array<[NationId, NationId]> = [];

  const minTotalUnits = Math.max(0, Math.round(declareBalance.minTotalUnits));
  const minUnitGap = Math.max(0, Math.round(declareBalance.minUnitGap));
  const unitRatio = Math.max(1, declareBalance.unitRatio);
  const evenUnitGap = Math.max(0, Math.round(declareBalance.evenUnitGap));
  const evenUnitRatio = Math.max(1, declareBalance.evenUnitRatio);
  const evenChance = clamp(declareBalance.evenChance, 0, 1);

  for (const [nationA, nationB] of adjacentPairs) {
    if (isAtWar(nationA, nationB, warAdjacency)) {
      continue;
    }

    const countA = unitCounts.get(nationA) ?? 0;
    const countB = unitCounts.get(nationB) ?? 0;
    if (countA + countB < minTotalUnits) {
      continue;
    }

    const [strongId, weakId, strongCount, weakCount] =
      countA >= countB
        ? [nationA, nationB, countA, countB]
        : [nationB, nationA, countB, countA];

    const gap = strongCount - weakCount;
    const ratio = (strongCount + 1) / (weakCount + 1);
    const isDominant = gap >= minUnitGap || ratio >= unitRatio;

    if (isDominant) {
      candidates.push([strongId, weakId]);
      continue;
    }

    if (gap <= evenUnitGap && ratio <= evenUnitRatio) {
      if (world.simRng.nextFloat() < evenChance) {
        const pickAggressorFirst = world.simRng.nextFloat() < 0.5;
        candidates.push(
          pickAggressorFirst ? [nationA, nationB] : [nationB, nationA],
        );
      }
    }
  }

  const maxWars = Math.max(0, Math.round(declareBalance.maxWarsPerTick));
  if (candidates.length === 0 || maxWars <= 0) {
    return;
  }

  const limit = Math.min(maxWars, candidates.length);
  for (let i = 0; i < limit; i += 1) {
    const pickIndex = world.simRng.nextInt(candidates.length);
    const [aggressorId, defenderId] = candidates.splice(pickIndex, 1)[0];
    const war = declareWar(world.wars, aggressorId, defenderId, world.time.fastTick);
    if (war) {
      console.info(
        `[War] ${war.nationAId} vs ${war.nationBId} start @${world.time.fastTick}`,
      );
    }
  }
}

function collectUnitCountsByNation(units: UnitState[]): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
  return counts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
