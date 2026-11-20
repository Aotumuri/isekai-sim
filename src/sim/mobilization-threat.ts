import type { NationId } from "../worldgen/nation";
import { buildWarAdjacency } from "./war-state";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function getMobilizationThreat(world: WorldState, nationId: NationId): number {
  return collectMobilizationThreats(world, [nationId]).get(nationId) ?? 0;
}

/** Take a threat snapshot before any nation changes its readiness. */
export function collectMobilizationThreats(
  world: WorldState,
  nationIds: readonly NationId[],
  wars = buildWarAdjacency(world.wars),
): Map<NationId, number> {
  const threats = new Map<NationId, number>();
  const nearby = new Map<NationId, Set<NationId>>();
  for (const id of nationIds) {
    if (wars.has(id)) threats.set(id, 1);
    else nearby.set(id, new Set());
  }
  if (!nearby.size) return threats;

  for (const exposure of world.strategicThreatObservation.exposures) {
    if (exposure.landAdjacent || exposure.sharedSeaComponent) {
      nearby.get(exposure.observerNationId)?.add(exposure.threatNationId);
    }
  }
  // Current borders supply contacts even before the first strategic snapshot.
  const owners = getOwnerByMesoId(world);
  for (const region of world.mesoRegions) {
    const owner = owners.get(region.id);
    const contacts = owner === undefined ? undefined : nearby.get(owner);
    if (!contacts) continue;
    for (const neighbor of region.neighbors) {
      const other = owners.get(neighbor.id);
      if (other && other !== owner) contacts.add(other);
    }
  }

  const readiness = world.mobilization?.byNationId;
  const now = world.time.slowTick;
  const raiseThreat = (id: NationId, value: number) => {
    if (value > (threats.get(id) ?? 0)) threats.set(id, value);
  };
  // Read the current relation table once, after diplomacy and war declarations.
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    const { nationAId: a, nationBId: b } = relation;
    if (relation.crisis) {
      if (nearby.has(a)) raiseThreat(a, 0.75);
      if (nearby.has(b)) raiseThreat(b, 0.75);
      continue;
    }
    const tension = relation.tension >= 55 && (relation.opinion < -15 || relation.grievance >= 25)
      ? (relation.tension >= 80 ? 0.6 : 0.35)
      : 0;
    const hostile = relation.opinion < -20;
    if (!tension && !hostile) continue;
    const aSeesB = nearby.get(a)?.has(b);
    const bSeesA = nearby.get(b)?.has(a);
    if (!aSeesB && !bSeesA) continue;
    if (relation.treaties.some(({ type, expiresAtSlowTick }) =>
      (type === "truce" || type === "alliance" || type === "non-aggression") && expiresAtSlowTick > now)) continue;
    if (aSeesB) raiseThreat(a, hostile && (readiness?.get(b)?.readiness ?? 0) >= 0.5 ? Math.max(tension, 0.5) : tension);
    if (bSeesA) raiseThreat(b, hostile && (readiness?.get(a)?.readiness ?? 0) >= 0.5 ? Math.max(tension, 0.5) : tension);
  }

  for (const id of nearby.keys()) {
    for (const intent of world.warIntent.assessmentsByNationId.get(id) ?? []) {
      if (world.time.fastTick - intent.evaluatedAtTick <= 120 && intent.aboveThreshold) raiseThreat(id, 0.55);
    }
  }
  return threats;
}
