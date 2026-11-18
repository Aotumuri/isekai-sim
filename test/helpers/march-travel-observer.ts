import type { WorldState } from "../../src/sim/world-state";
import type { UnitState } from "../../src/sim/unit";

interface MarchSample {
  nation: string; region: string; target: string | null; to: string | null;
  progress: number; front?: string; revision?: number; ordinary: boolean; blocked: boolean;
}

/** Diagnostic-only, no commands, lazy game getters, random draws or route edits.
 * Exclude enemy-blocked arrivals rather than treating failed entry as waste. */
export function createMarchTravelObserver() {
  let previous = new Map<string, MarchSample>(), lastTick = -1;
  const totals = { ordinaryTravelMs: 0, ordinarySameEdgeRetargets: 0, ordinaryResetEvents: 0,
    ordinaryDiscardedProgressMs: 0, allUnblockedSameEdgeRetargets: 0,
    allUnblockedResetEvents: 0, allUnblockedDiscardedProgressMs: 0,
    sameFrontTravelMs: 0, sameFrontSameEdgeRetargets: 0,
    sameFrontResetEvents: 0, sameFrontDiscardedProgressMs: 0 };
  return { result: () => ({ ...totals }), observe(world: WorldState) {
    const elapsed = lastTick < 0 ? 0 : Math.max(0, world.time.fastTick - lastTick) * 100;
    lastTick = world.time.fastTick;
    const enemies = new Map<string, Set<string>>();
    for (const war of world.wars) for (const [a, b] of [[war.nationAId, war.nationBId], [war.nationBId, war.nationAId]]) {
      const set = enemies.get(a) ?? new Set(); set.add(b); enemies.set(a, set);
    }
    const present = new Map<string, Set<string>>();
    for (const unit of world.units) if (unit.domain === "land") {
      const set = present.get(unit.regionId) ?? new Set(); set.add(unit.nationId); present.set(unit.regionId, set);
    }
    const next = new Map<string, MarchSample>();
    for (const unit of world.units) {
      if (unit.domain !== "land") continue;
      const after = sampleMarch(world, unit);
      after.blocked = !!unit.moveToId && [...(present.get(unit.moveToId) ?? [])].some((id) => enemies.get(unit.nationId)?.has(id));
      next.set(unit.id, after);
      const before = previous.get(unit.id);
      if (!before || !elapsed || before.nation !== after.nation) continue;
      const sameFront = before.ordinary && after.ordinary && before.front === after.front;
      const ordinary = sameFront && before.revision === after.revision;
      if (sameFront && before.to && !before.blocked) totals.sameFrontTravelMs += elapsed;
      if (ordinary && before.to && !before.blocked) totals.ordinaryTravelMs += elapsed;
      if (!before.to || before.progress <= 0 || before.region !== after.region || before.to !== after.to ||
        !after.target || before.target === after.target || before.blocked || after.blocked) continue;
      const lost = Math.min(before.progress, Math.max(0, before.progress + elapsed - after.progress));
      totals.allUnblockedSameEdgeRetargets++;
      if (lost > 0) { totals.allUnblockedResetEvents++; totals.allUnblockedDiscardedProgressMs += lost; }
      if (sameFront) {
        totals.sameFrontSameEdgeRetargets++;
        if (lost > 0) { totals.sameFrontResetEvents++; totals.sameFrontDiscardedProgressMs += lost; }
      }
      if (!ordinary) continue;
      totals.ordinarySameEdgeRetargets++;
      if (lost > 0) { totals.ordinaryResetEvents++; totals.ordinaryDiscardedProgressMs += lost; }
    }
    previous = next;
  } };
}

function sampleMarch(world: WorldState, unit: UnitState): MarchSample {
  const front = world.frontAllocations.frontIdByUnitId.get(unit.id);
  const player = world.playerNation;
  const manual = player?.nationId === unit.nationId && (player.commandMode === "manual" || player.landOrders.has(unit.id));
  const ordinary = !!front && world.landFronts.operationalSectorsById.has(front) && !manual &&
    world.capitalDefense.assessmentsByNationId.get(unit.nationId)?.threatLevel !== "critical" &&
    !world.amphibiousOperations.operationByUnitId.has(unit.id) && !world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) &&
    !world.strategicReserves.reserveNationByUnitId.has(unit.id) && !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
    !world.reorganization.planIdByUnitId.has(unit.id) && !world.offensiveOperations.operationIdByUnitId.has(unit.id);
  return { nation: unit.nationId, region: unit.regionId, target: unit.moveTargetId, to: unit.moveToId,
    progress: unit.moveProgressMs, front, revision: world.warCampaigns?.byNationId.get(unit.nationId)?.revision,
    ordinary, blocked: false };
}
