import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode } from "./simulation-settings";
import { daysToSlowTicks, fastTicksToDays } from "./time";
import type { WorldState } from "./world-state";

const REVIEW_DAYS = 100;
const EXPIRY_DAYS = 1100;
export const REDISTRIBUTION_REVIEW_INTERVAL = daysToSlowTicks(REVIEW_DAYS);

export interface RecentAcquisition {
  owner: NationId;
  acquiredOn: number;
  subjectIds: ReadonlySet<NationId>;
  reviewAt: number;
  expiresAt: number;
}

/** Called only by legal ownership transitions, never by occupation. */
export function updateRecentAcquisitions(
  world: WorldState, owner: NationId, ids: readonly MesoRegionId[], eligible: boolean,
): void {
  for (const id of ids) world.recentAcquisitions?.delete(id);
  if (!eligible || !ids.length || getWarDeclarationMode(world) !== "diplomacy") return;
  let subjectIds: Set<NationId> | undefined;
  for (const nation of world.nations) {
    if (nation.subjectGovernment?.overlordId === owner && isNationActive(nation)) (subjectIds ??= new Set()).add(nation.id);
  }
  if (!subjectIds) return;
  const now = fastTicksToDays(world.time.fastTick);
  const acquisition: RecentAcquisition = {
    owner, acquiredOn: world.time.fastTick, subjectIds,
    reviewAt: daysToSlowTicks(now + REVIEW_DAYS), expiresAt: daysToSlowTicks(now + EXPIRY_DAYS),
  };
  const pending = world.recentAcquisitions ??= new Map();
  for (const id of ids) pending.set(id, acquisition);
}
