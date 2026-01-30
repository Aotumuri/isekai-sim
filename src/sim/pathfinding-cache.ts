import type { MesoRegionId } from "../worldgen/meso-region";
import type { TargetField } from "./nation/movement-utils";
import type { WorldCache } from "./world-cache";

const DEFAULT_DISTANCE_FIELD_MAX_ENTRIES = 256;
const DEFAULT_ALLOWED_SET_MAX_ENTRIES = 128;
const DEFAULT_TARGET_FIELD_MAX_ENTRIES = 128;

export function getCachedDistanceField(
  cache: WorldCache,
  key: string,
  build: () => Map<MesoRegionId, number>,
): Map<MesoRegionId, number> {
  const existing = cache.distanceFieldByKey.get(key);
  if (existing) {
    cache.distanceFieldByKey.delete(key);
    cache.distanceFieldByKey.set(key, existing);
    return existing.distanceById;
  }

  const distanceById = build();
  cache.distanceFieldByKey.set(key, { distanceById });
  pruneDistanceFieldCache(cache);
  return distanceById;
}

export function peekCachedDistanceField(
  cache: WorldCache,
  key: string,
): Map<MesoRegionId, number> | null {
  const existing = cache.distanceFieldByKey.get(key);
  if (!existing) {
    return null;
  }
  cache.distanceFieldByKey.delete(key);
  cache.distanceFieldByKey.set(key, existing);
  return existing.distanceById;
}

export function getCachedAllowedSet(
  cache: WorldCache,
  key: string,
  build: () => Set<MesoRegionId>,
): Set<MesoRegionId> {
  const existing = cache.allowedSetByKey.get(key);
  if (existing) {
    cache.allowedSetByKey.delete(key);
    cache.allowedSetByKey.set(key, existing);
    return existing;
  }

  const allowed = build();
  cache.allowedSetByKey.set(key, allowed);
  pruneAllowedSetCache(cache);
  return allowed;
}

export function getCachedTargetField(
  cache: WorldCache,
  key: string,
  build: () => TargetField,
): TargetField {
  const existing = cache.targetFieldByKey.get(key);
  if (existing) {
    cache.targetFieldByKey.delete(key);
    cache.targetFieldByKey.set(key, existing);
    return existing;
  }

  const field = build();
  cache.targetFieldByKey.set(key, field);
  pruneTargetFieldCache(cache);
  return field;
}

function pruneDistanceFieldCache(cache: WorldCache): void {
  const maxEntries = cache.distanceFieldMaxEntries || DEFAULT_DISTANCE_FIELD_MAX_ENTRIES;
  while (cache.distanceFieldByKey.size > maxEntries) {
    const oldestKey = cache.distanceFieldByKey.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    cache.distanceFieldByKey.delete(oldestKey);
  }
}

function pruneAllowedSetCache(cache: WorldCache): void {
  const maxEntries = cache.allowedSetMaxEntries || DEFAULT_ALLOWED_SET_MAX_ENTRIES;
  while (cache.allowedSetByKey.size > maxEntries) {
    const oldestKey = cache.allowedSetByKey.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    cache.allowedSetByKey.delete(oldestKey);
  }
}

function pruneTargetFieldCache(cache: WorldCache): void {
  const maxEntries = cache.targetFieldMaxEntries || DEFAULT_TARGET_FIELD_MAX_ENTRIES;
  while (cache.targetFieldByKey.size > maxEntries) {
    const oldestKey = cache.targetFieldByKey.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    cache.targetFieldByKey.delete(oldestKey);
  }
}
