import type { NationRuntime } from "../../src/sim/nation-runtime";
import { campaignWarKey } from "../../src/sim/war-campaign/state";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";

export type CapitalDaySample = { threat: string; capitalStrength: number; capitalUnits: number };

function createSide(world: WorldState, nationId: NationId, opponentId: NationId) {
  return {
    nationId, opponentId,
    days: 0, threatenedDays: 0, undefendedDays: 0, vacantDays: 0, fuelEmptyDays: 0,
    fuelObservations: 0, upkeepFuelDemand: 0, upkeepFuelConsumed: 0,
    lastFlowTick: world.time.slowTick,
    operations: new Set<string>(), commanderEvaluations: new Set<string>(),
  };
}

export function createCampaignWarExposureObserver() {
  const tracked = new Map<string, ReturnType<typeof createSide>[]>();

  function observe(world: WorldState, capitals: ReadonlyMap<NationId, CapitalDaySample>) {
    const day = world.time.fastTick;
    const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
    for (const war of world.wars) {
      const key = campaignWarKey(war.nationAId, war.nationBId, war.startedAtFastTick);
      let sides = tracked.get(key);
      if (!sides) {
        sides = [
          createSide(world, war.aggressorId, war.defenderId),
          createSide(world, war.defenderId, war.aggressorId),
        ];
        tracked.set(key, sides);
      }
      for (const side of sides) {
        if (day > 0) sampleDay(side, nations.get(side.nationId), capitals.get(side.nationId));
        for (const operation of world.offensiveOperations.operations) {
          if (operation.startedAtTick < war.startedAtFastTick ||
            operation.nationId !== side.nationId || operation.enemyNationId !== side.opponentId) continue;
          side.operations.add(operation.id);
          if (operation.theaterLaunchDecision) side.commanderEvaluations.add(operation.id);
        }
      }
    }
  }

  function result() {
    return Object.fromEntries([...tracked].map(([key, sides]) => [key,
      sides.map(({ operations, commanderEvaluations, lastFlowTick, ...side }) => ({
        ...side, operations: operations.size, commanderEvaluations: commanderEvaluations.size,
      })),
    ]));
  }

  return { observe, result };
}

function sampleDay(side: ReturnType<typeof createSide>, nation: NationRuntime | undefined, capital: CapitalDaySample | undefined) {
  side.days++;
  if (capital && capital.threat !== "none") {
    side.threatenedDays++;
    if (capital.capitalStrength <= 0) side.undefendedDays++;
    if (capital.capitalUnits === 0) side.vacantDays++;
  }
  if (!nation) return;
  if (nation.resources.fuel <= 0) side.fuelEmptyDays++;
  const flow = nation.resourceFlow;
  if (flow.lastTick <= side.lastFlowTick) return;
  side.lastFlowTick = flow.lastTick;
  if (!flow.industry) return;
  side.fuelObservations++;
  side.upkeepFuelDemand += flow.industry.fuelDemand;
  side.upkeepFuelConsumed += flow.industry.fuelConsumed;
}
