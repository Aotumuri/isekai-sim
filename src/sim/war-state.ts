import type { NationId } from "../worldgen/nation";

export type WarId = string & { __brand: "WarId" };

export interface WarState {
  id: WarId;
  nationAId: NationId;
  nationBId: NationId;
  startedAtFastTick: number;
  isTest: boolean;
  contributionByNationId: Map<NationId, number>;
}

export type WarAdjacency = Map<NationId, Set<NationId>>;

export function createWarId(index: number): WarId {
  return `war-${index}` as WarId;
}

export function normalizeWarPair(
  nationAId: NationId,
  nationBId: NationId,
): [NationId, NationId] {
  return nationAId < nationBId ? [nationAId, nationBId] : [nationBId, nationAId];
}

export function declareWar(
  wars: WarState[],
  nationAId: NationId,
  nationBId: NationId,
  startedAtFastTick: number,
  isTest = false,
): WarState | null {
  if (nationAId === nationBId) {
    return null;
  }

  const [normalizedA, normalizedB] = normalizeWarPair(nationAId, nationBId);
  for (const war of wars) {
    if (war.nationAId === normalizedA && war.nationBId === normalizedB) {
      return null;
    }
  }

  const war: WarState = {
    id: createWarId(wars.length),
    nationAId: normalizedA,
    nationBId: normalizedB,
    startedAtFastTick,
    isTest,
    contributionByNationId: new Map([
      [normalizedA, 0],
      [normalizedB, 0],
    ]),
  };
  wars.push(war);
  return war;
}

export function buildWarAdjacency(wars: WarState[]): WarAdjacency {
  const adjacency: WarAdjacency = new Map();
  for (const war of wars) {
    const listA = adjacency.get(war.nationAId);
    if (listA) {
      listA.add(war.nationBId);
    } else {
      adjacency.set(war.nationAId, new Set([war.nationBId]));
    }

    const listB = adjacency.get(war.nationBId);
    if (listB) {
      listB.add(war.nationAId);
    } else {
      adjacency.set(war.nationBId, new Set([war.nationAId]));
    }
  }
  return adjacency;
}

export function isAtWar(
  nationAId: NationId,
  nationBId: NationId,
  adjacency: WarAdjacency,
): boolean {
  if (nationAId === nationBId) {
    return false;
  }
  const list = adjacency.get(nationAId);
  return list ? list.has(nationBId) : false;
}

export function findWar(
  wars: WarState[],
  nationAId: NationId,
  nationBId: NationId,
): WarState | null {
  if (nationAId === nationBId) {
    return null;
  }
  const [normalizedA, normalizedB] = normalizeWarPair(nationAId, nationBId);
  for (const war of wars) {
    if (war.nationAId === normalizedA && war.nationBId === normalizedB) {
      return war;
    }
  }
  return null;
}

export function addWarContribution(
  wars: WarState[],
  contributorId: NationId,
  opponentId: NationId,
  amount: number,
): void {
  if (amount <= 0) {
    return;
  }
  const war = findWar(wars, contributorId, opponentId);
  if (!war) {
    return;
  }
  const current = war.contributionByNationId.get(contributorId) ?? 0;
  war.contributionByNationId.set(contributorId, current + amount);
}
