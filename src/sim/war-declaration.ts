import type { WorldState } from "./world-state";
import { pickWarDeclarations, scheduleNextWarDeclarations } from "./nation/war-declare-logic";
import { declareWar } from "./war-state";

export function updateWarDeclarations(world: WorldState): void {
  const { readyNationIds, candidates, maxWars, declareRange } = pickWarDeclarations(world);
  scheduleNextWarDeclarations(world, readyNationIds, declareRange);
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
