import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WarState } from "./war-state";
import { buildWarAdjacency } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById } from "./world-cache";

export function updateWarCooperation(world: WorldState): void {
  if (world.nations.length === 0) {
    return;
  }

  const cooperationBalance = WORLD_BALANCE.war.cooperation;
  const mesoById = getMesoById(world);
  const cityCountsByNation = collectCityCountsByNation(
    world.macroRegions,
    mesoById,
    world.occupation.mesoById,
  );
  const warAdjacency = buildWarAdjacency(world.wars);
  const warDurationsByNation = collectWarDurationByNation(
    world.wars,
    world.time.fastTick,
  );
  const warRoleCountsByNation = collectWarRoleCounts(world.wars);

  for (const nation of world.nations) {
    const nextBoost = Math.max(
      0,
      nation.warCooperationBoost - cooperationBalance.civilWarBoostDecay,
    );
    nation.warCooperationBoost = nextBoost;

    const isAtWar = (warAdjacency.get(nation.id)?.size ?? 0) > 0;
    if (!isAtWar) {
      const recovery = Math.max(0, cooperationBalance.peaceRecoveryPerTick);
      if (recovery > 0) {
        nation.warCooperation = clamp(
          nation.warCooperation + recovery,
          cooperationBalance.min,
          cooperationBalance.max,
        );
      }
      continue;
    }

    const duration = warDurationsByNation.get(nation.id) ?? 0;
    const durationRatio = clamp(
      duration / Math.max(1, cooperationBalance.durationTicksForMaxPenalty),
      0,
      1,
    );
    const capitalFallRatio = clamp(
      nation.capitalFallCount / Math.max(1, cooperationBalance.capitalFallMax),
      0,
      1,
    );
    const currentCities = cityCountsByNation.get(nation.id) ?? 0;
    const cityLossRatio = clamp(
      1 - currentCities / Math.max(1, nation.initialCityCount),
      0,
      1,
    );
    const rolePenaltyMultiplier = getRolePenaltyMultiplier(
      warRoleCountsByNation.get(nation.id),
      cooperationBalance,
    );
    const totalPenalty =
      (durationRatio * cooperationBalance.durationWeight +
        capitalFallRatio * cooperationBalance.capitalFallWeight +
        cityLossRatio * cooperationBalance.cityLossWeight) *
      rolePenaltyMultiplier;
    const targetCooperation = clamp(
      cooperationBalance.max - totalPenalty + nextBoost,
      cooperationBalance.min,
      cooperationBalance.max,
    );
    if (targetCooperation < nation.warCooperation) {
      nation.warCooperation = targetCooperation;
    }
  }
}

function collectWarDurationByNation(
  wars: WarState[],
  currentFastTick: number,
): Map<NationId, number> {
  const durations = new Map<NationId, number>();
  for (const war of wars) {
    const duration = Math.max(0, currentFastTick - war.startedAtFastTick);
    const currentA = durations.get(war.nationAId) ?? 0;
    if (duration > currentA) {
      durations.set(war.nationAId, duration);
    }
    const currentB = durations.get(war.nationBId) ?? 0;
    if (duration > currentB) {
      durations.set(war.nationBId, duration);
    }
  }
  return durations;
}

type WarRoleCounts = {
  aggressor: number;
  defender: number;
};

function collectWarRoleCounts(wars: WarState[]): Map<NationId, WarRoleCounts> {
  const counts = new Map<NationId, WarRoleCounts>();
  for (const war of wars) {
    const aggressor = counts.get(war.aggressorId) ?? { aggressor: 0, defender: 0 };
    aggressor.aggressor += 1;
    counts.set(war.aggressorId, aggressor);

    const defender = counts.get(war.defenderId) ?? { aggressor: 0, defender: 0 };
    defender.defender += 1;
    counts.set(war.defenderId, defender);
  }
  return counts;
}

function getRolePenaltyMultiplier(
  roleCounts: WarRoleCounts | undefined,
  cooperationBalance: typeof WORLD_BALANCE.war.cooperation,
): number {
  if (!roleCounts) {
    return 1;
  }
  const total = roleCounts.aggressor + roleCounts.defender;
  if (total <= 0) {
    return 1;
  }
  const aggressorRatio = roleCounts.aggressor / total;
  const defenderRatio = roleCounts.defender / total;
  return (
    aggressorRatio * cooperationBalance.aggressorPenaltyMultiplier +
    defenderRatio * cooperationBalance.defenderPenaltyMultiplier
  );
}

function collectCityCountsByNation(
  macroRegions: MacroRegion[],
  mesoById: Map<MesoRegion["id"], MesoRegion>,
  occupationByMesoId: Map<MesoRegion["id"], NationId>,
): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      const meso = mesoById.get(mesoId);
      if (!meso || meso.type === "sea") {
        continue;
      }
      if (!isCityBuilding(meso.building)) {
        continue;
      }
      const occupier = occupationByMesoId.get(mesoId);
      if (occupier && occupier !== macro.nationId) {
        continue;
      }
      counts.set(macro.nationId, (counts.get(macro.nationId) ?? 0) + 1);
    }
  }
  return counts;
}

function isCityBuilding(building: MesoRegion["building"]): boolean {
  return building === "city" || building === "capital";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
