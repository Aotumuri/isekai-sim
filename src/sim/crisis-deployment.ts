import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitState } from "./unit";
import { getWarDeclarationMode } from "./simulation-settings";
import { buildWarAdjacency } from "./war-state";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

interface Deployment {
  opponent: NationId;
  destination: MesoRegionId;
  unit: UnitState;
}

const deployments = new WeakMap<WorldState, Map<UnitState["id"], Deployment>>();

export function updateCrisisDeployments(world: WorldState): void {
  const crises = getWarDeclarationMode(world) === "diplomacy"
    ? [...(world.diplomacy?.relations.values() ?? [])].filter((relation) => relation.crisis) : [];
  const old = deployments.get(world);
  if (!crises.length && !old?.size) return;
  const next = new Map<UnitState["id"], Deployment>();
  const wars = buildWarAdjacency(world.wars);
  const owners = getOwnerByMesoId(world);
  const regions = new Map(world.mesoRegions.filter((region) => region.type !== "sea").map((region) => [region.id, region]));
  const controlledBy = (id: MesoRegionId) => world.occupation.mesoById.get(id) ?? owners.get(id);
  crises.sort((a, b) => a.crisis!.deadlineSlowTick - b.crisis!.deadlineSlowTick);

  for (const relation of crises) {
    for (const [nation, opponent] of [[relation.nationAId, relation.nationBId], [relation.nationBId, relation.nationAId]]) {
      // Existing wars retain their front, retreat and capital-defense assignments.
      if (wars.has(nation)) continue;
      const friendly = (id: MesoRegionId) => owners.get(id) === nation && controlledBy(id) === nation;
      const border = [...regions.values()].filter((region) => friendly(region.id) &&
        region.neighbors.some(({ id }) => regions.has(id) && owners.get(id) === opponent && controlledBy(id) === opponent));
      if (!border.length) continue;
      const goals = new Set(relation.crisis!.regionIds);
      border.sort((a, b) => Number(b.neighbors.some(({ id }) => goals.has(id))) -
        Number(a.neighbors.some(({ id }) => goals.has(id))));
      const queue = border.map(({ id }) => id);
      const nearest = new Map(queue.map((id) => [id, { destination: id, distance: 0 }]));
      for (let i = 0; i < queue.length; i++) {
        const entry = nearest.get(queue[i])!;
        for (const { id } of regions.get(queue[i])!.neighbors) {
          if (!regions.has(id) || !friendly(id) || nearest.has(id)) continue;
          nearest.set(id, { destination: entry.destination, distance: entry.distance + 1 });
          queue.push(id);
        }
      }
      const candidates = world.units.filter((unit) => unit.nationId === nation && unit.domain === "land" &&
        unit.manpower > 0 && !next.has(unit.id) && nearest.has(unit.regionId) &&
        !world.militaryAccess?.orders.has(unit.id) && !world.amphibiousOperations.operationByUnitId.has(unit.id) &&
        !world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id));
      candidates.sort((a, b) => nearest.get(a.regionId)!.distance - nearest.get(b.regionId)!.distance);
      const count = Math.max(1, Math.ceil(candidates.length * 0.65));
      for (const unit of candidates.slice(0, count)) {
        const previous = old?.get(unit.id);
        const destination = previous?.opponent === opponent && nearest.get(previous.destination)?.distance === 0
          ? previous.destination : nearest.get(unit.regionId)!.destination;
        next.set(unit.id, { unit, opponent, destination });
      }
    }
  }
  for (const [id, order] of old ?? []) {
    if (next.has(id) || order.unit.moveTargetId !== order.destination) continue;
    order.unit.moveTargetId = null;
    order.unit.moveFromId = null;
    order.unit.moveToId = null;
    order.unit.moveProgressMs = 0;
  }
  deployments.set(world, next);
}

export function getCrisisDeploymentReadiness(world: WorldState, nation: NationId, opponent: NationId): number | undefined {
  if (getWarDeclarationMode(world) !== "diplomacy") return undefined;
  let staged = 0, total = 0;
  for (const { unit, destination, opponent: target } of deployments.get(world)?.values() ?? []) {
    if (unit.nationId !== nation || target !== opponent || unit.manpower <= 0) continue;
    total += unit.manpower;
    if (unit.regionId === destination && !unit.moveToId) staged += unit.manpower;
  }
  return total > 0 ? staged / total : undefined;
}

export function applyCrisisDeployments(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  for (const { unit, opponent, destination } of deployments.get(world)?.values() ?? []) {
    const relation = world.diplomacy?.relations.get([unit.nationId, opponent].sort().join(":"));
    if (relation?.crisis && !world.wars.some((war) => war.nationAId === unit.nationId || war.nationBId === unit.nationId)) {
      unit.moveTargetId = destination;
    }
  }
}
