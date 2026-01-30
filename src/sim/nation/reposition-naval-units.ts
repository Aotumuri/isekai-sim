import type { WorldState } from "../world-state";
import type { UnitState } from "../unit";
import type { MesoRegion, MesoRegionId } from "../../worldgen/meso-region";
import type { NationId } from "../../worldgen/nation";
import { buildWarAdjacency, type WarAdjacency } from "../war-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "../world-cache";
import { findNearestTarget, moveUnitTowardTarget, resetMovement } from "./movement-utils";

export function repositionNavalUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }
  const navalUnits = world.units.filter((unit) => unit.domain === "naval");
  if (navalUnits.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  const warAdjacency = buildWarAdjacency(world.wars);

  const unitsByNation = collectUnitsByNation(navalUnits);
  const homeSeasByNation = collectCoastalSeasByNation(
    world.mesoRegions,
    mesoById,
    ownerByMesoId,
    occupationByMesoId,
  );
  const portsByNation = collectPortsByNation(
    world.mesoRegions,
    ownerByMesoId,
    occupationByMesoId,
  );
  const enemyCoastalTargetsByNation = collectEnemyCoastalTargetsByNation(
    world.mesoRegions,
    mesoById,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
  );
  const enemyNavalSeasByNation = collectEnemyNavalSeasByNation(
    navalUnits,
    mesoById,
    warAdjacency,
  );

  for (const [nationId, units] of unitsByNation.entries()) {
    const combatShips = units.filter((unit) => unit.type === "CombatShip");
    const transports = units.filter((unit) => unit.type === "TransportShip");
    const homeSeas = homeSeasByNation.get(nationId) ?? [];
    const portTargets = portsByNation.get(nationId) ?? [];
    const enemySeas = enemyNavalSeasByNation.get(nationId) ?? new Set<MesoRegionId>();
    const enemyInHome = homeSeas.filter((id) => enemySeas.has(id));
    const enemyNear = collectEnemySeasNearHome(
      homeSeas,
      enemySeas,
      neighborsById,
      mesoById,
    );
    const landingPlan = transports.length > 0
      ? planLandingForNation(
          nationId,
          homeSeas,
          portTargets,
          enemyCoastalTargetsByNation.get(nationId) ?? [],
          neighborsById,
          mesoById,
          ownerByMesoId,
        )
      : null;

    assignTransportTargets(
      transports,
      landingPlan,
      portTargets,
      neighborsById,
      mesoById,
      ownerByMesoId,
    );
    assignCombatShipTargets(
      combatShips,
      homeSeas,
      portTargets,
      enemyInHome,
      enemyNear,
      landingPlan,
    );
  }

  for (const unit of navalUnits) {
    const current = mesoById.get(unit.regionId);
    if (!current || !isNavalNode(current, unit.nationId, ownerByMesoId)) {
      resetMovement(unit);
      continue;
    }

    if (!unit.moveTargetId) {
      resetMovement(unit);
      continue;
    }

    moveUnitTowardTarget(
      unit,
      dtMs,
      neighborsById,
      (id) => {
        const meso = mesoById.get(id);
        return !!meso && isNavalNode(meso, unit.nationId, ownerByMesoId);
      },
      () => false,
    );
  }
}

interface LandingPlan {
  targetSeaId: MesoRegionId;
  escortTargets: MesoRegionId[];
}

function isNavalNode(
  meso: MesoRegion,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (meso.type === "sea") {
    return true;
  }
  if (meso.building === "port") {
    return ownerByMesoId.get(meso.id) === nationId;
  }
  return false;
}

function collectUnitsByNation(units: UnitState[]): Map<NationId, UnitState[]> {
  const byNation = new Map<NationId, UnitState[]>();
  for (const unit of units) {
    const list = byNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      byNation.set(unit.nationId, [unit]);
    }
  }
  return byNation;
}

function collectPortsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea" || meso.building !== "port") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    if (occupier && occupier !== owner) {
      continue;
    }
    const list = result.get(owner);
    if (list) {
      list.push(meso.id);
    } else {
      result.set(owner, [meso.id]);
    }
  }
  return result;
}

function collectCoastalSeasByNation(
  mesoRegions: MesoRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const seasByNation = new Map<NationId, Set<MesoRegionId>>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    if (occupier && occupier !== owner) {
      continue;
    }
    for (const neighbor of meso.neighbors) {
      const neighborMeso = mesoById.get(neighbor.id);
      if (!neighborMeso || neighborMeso.type !== "sea") {
        continue;
      }
      let set = seasByNation.get(owner);
      if (!set) {
        set = new Set<MesoRegionId>();
        seasByNation.set(owner, set);
      }
      set.add(neighborMeso.id);
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of seasByNation.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

function collectEnemyCoastalTargetsByNation(
  mesoRegions: MesoRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    if (!isCoastalLand(meso, mesoById)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    const controller = occupier && occupier !== owner ? occupier : owner;
    const enemies = warAdjacency.get(controller);
    if (!enemies) {
      continue;
    }
    for (const enemy of enemies) {
      if (enemy === controller) {
        continue;
      }
      const list = result.get(enemy);
      if (list) {
        list.push(meso.id);
      } else {
        result.set(enemy, [meso.id]);
      }
    }
  }
  return result;
}

function isCoastalLand(
  meso: MesoRegion,
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  for (const neighbor of meso.neighbors) {
    const neighborMeso = mesoById.get(neighbor.id);
    if (neighborMeso && neighborMeso.type === "sea") {
      return true;
    }
  }
  return false;
}

function collectEnemyNavalSeasByNation(
  navalUnits: UnitState[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): Map<NationId, Set<MesoRegionId>> {
  const nationsBySea = new Map<MesoRegionId, Set<NationId>>();
  for (const unit of navalUnits) {
    const meso = mesoById.get(unit.regionId);
    if (!meso || meso.type !== "sea") {
      continue;
    }
    let set = nationsBySea.get(unit.regionId);
    if (!set) {
      set = new Set<NationId>();
      nationsBySea.set(unit.regionId, set);
    }
    set.add(unit.nationId);
  }

  const result = new Map<NationId, Set<MesoRegionId>>();
  for (const [seaId, nations] of nationsBySea.entries()) {
    for (const presentNation of nations) {
      const enemies = warAdjacency.get(presentNation);
      if (!enemies) {
        continue;
      }
      for (const enemy of enemies) {
        let set = result.get(enemy);
        if (!set) {
          set = new Set<MesoRegionId>();
          result.set(enemy, set);
        }
        set.add(seaId);
      }
    }
  }
  return result;
}

function collectEnemySeasNearHome(
  homeSeas: MesoRegionId[],
  enemySeas: Set<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  const homeSet = new Set(homeSeas);
  const result = new Set<MesoRegionId>();
  for (const seaId of homeSeas) {
    const neighbors = neighborsById.get(seaId) ?? [];
    for (const neighborId of neighbors) {
      if (homeSet.has(neighborId)) {
        continue;
      }
      const neighbor = mesoById.get(neighborId);
      if (!neighbor || neighbor.type !== "sea") {
        continue;
      }
      if (enemySeas.has(neighborId)) {
        result.add(neighborId);
      }
    }
  }
  return [...result];
}

function planLandingForNation(
  nationId: NationId,
  homeSeas: MesoRegionId[],
  ports: MesoRegionId[],
  enemyCoastalTargets: MesoRegionId[],
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): LandingPlan | null {
  if (enemyCoastalTargets.length === 0) {
    return null;
  }
  const sources = uniqueIds([...homeSeas, ...ports]);
  if (sources.length === 0) {
    return null;
  }
  const search = buildNavalSearch(
    sources,
    neighborsById,
    mesoById,
    ownerByMesoId,
    nationId,
  );

  let bestSea: MesoRegionId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const landId of enemyCoastalTargets) {
    const seas = collectAdjacentSeaIds(landId, mesoById);
    for (const seaId of seas) {
      const dist = search.distance.get(seaId);
      if (dist === undefined) {
        continue;
      }
      if (dist < bestDistance) {
        bestDistance = dist;
        bestSea = seaId;
      }
    }
  }

  if (!bestSea) {
    return null;
  }

  const path = buildPath(bestSea, search.previous);
  const escortTargets = path
    .filter((id) => mesoById.get(id)?.type === "sea")
    .reverse();
  if (escortTargets.length === 0) {
    escortTargets.push(bestSea);
  }

  return { targetSeaId: bestSea, escortTargets };
}

function buildNavalSearch(
  sources: MesoRegionId[],
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  nationId: NationId,
): { distance: Map<MesoRegionId, number>; previous: Map<MesoRegionId, MesoRegionId | null> } {
  const distance = new Map<MesoRegionId, number>();
  const previous = new Map<MesoRegionId, MesoRegionId | null>();
  const queue: MesoRegionId[] = [];

  for (const source of sources) {
    const meso = mesoById.get(source);
    if (!meso || !isNavalNode(meso, nationId, ownerByMesoId)) {
      continue;
    }
    if (distance.has(source)) {
      continue;
    }
    distance.set(source, 0);
    previous.set(source, null);
    queue.push(source);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const currentDistance = distance.get(current) ?? 0;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (distance.has(neighbor)) {
        continue;
      }
      const meso = mesoById.get(neighbor);
      if (!meso || !isNavalNode(meso, nationId, ownerByMesoId)) {
        continue;
      }
      distance.set(neighbor, currentDistance + 1);
      previous.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  return { distance, previous };
}

function buildPath(
  targetId: MesoRegionId,
  previous: Map<MesoRegionId, MesoRegionId | null>,
): MesoRegionId[] {
  const path: MesoRegionId[] = [];
  let current: MesoRegionId | null = targetId;
  while (current) {
    path.push(current);
    current = previous.get(current) ?? null;
  }
  return path.reverse();
}

function assignTransportTargets(
  transports: UnitState[],
  landingPlan: LandingPlan | null,
  portTargets: MesoRegionId[],
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): void {
  if (transports.length === 0) {
    return;
  }
  const nationId = transports[0]?.nationId;
  if (!nationId) {
    return;
  }
  const portSet = new Set(portTargets);
  const isAllowed = (id: MesoRegionId): boolean => {
    const meso = mesoById.get(id);
    return !!meso && isNavalNode(meso, nationId, ownerByMesoId);
  };
  const ordered = [...transports].sort((a, b) => a.id.localeCompare(b.id));
  for (const unit of ordered) {
    if (landingPlan && unit.cargoUnitIds.length > 0) {
      unit.moveTargetId = landingPlan.targetSeaId;
      continue;
    }
    if (portSet.size === 0) {
      unit.moveTargetId = null;
      continue;
    }
    const target = findNearestTarget(
      unit.regionId,
      portSet,
      new Set<MesoRegionId>(),
      neighborsById,
      isAllowed,
    );
    unit.moveTargetId = target;
  }
}

function assignCombatShipTargets(
  combatShips: UnitState[],
  homeSeas: MesoRegionId[],
  portTargets: MesoRegionId[],
  enemyInHome: MesoRegionId[],
  enemyNear: MesoRegionId[],
  landingPlan: LandingPlan | null,
): void {
  if (combatShips.length === 0) {
    return;
  }
  const ordered = [...combatShips].sort((a, b) => a.id.localeCompare(b.id));
  const defenseNeeded = Math.min(homeSeas.length, ordered.length);
  const defenders = ordered.slice(0, defenseNeeded);
  const offense = ordered.slice(defenseNeeded);

  const defenseTargets =
    enemyInHome.length > 0
      ? enemyInHome
      : homeSeas.length > 0
        ? homeSeas
        : portTargets;
  assignTargetsRoundRobin(defenders, defenseTargets);

  let remainingOffense = offense;
  if (landingPlan && landingPlan.escortTargets.length > 0) {
    const escortShips = remainingOffense.slice(0, landingPlan.escortTargets.length);
    assignTargetsSequential(escortShips, landingPlan.escortTargets);
    remainingOffense = remainingOffense.slice(escortShips.length);
  }

  const offenseTargets =
    enemyNear.length > 0
      ? enemyNear
      : enemyInHome.length > 0
        ? enemyInHome
        : homeSeas.length > 0
          ? homeSeas
          : portTargets;
  assignTargetsRoundRobin(remainingOffense, offenseTargets);
}

function assignTargetsRoundRobin(units: UnitState[], targets: MesoRegionId[]): void {
  if (units.length === 0) {
    return;
  }
  if (targets.length === 0) {
    for (const unit of units) {
      unit.moveTargetId = null;
    }
    return;
  }
  for (let i = 0; i < units.length; i += 1) {
    units[i].moveTargetId = targets[i % targets.length];
  }
}

function assignTargetsSequential(units: UnitState[], targets: MesoRegionId[]): void {
  const count = Math.min(units.length, targets.length);
  for (let i = 0; i < count; i += 1) {
    units[i].moveTargetId = targets[i];
  }
}

function collectAdjacentSeaIds(
  landId: MesoRegionId,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  const land = mesoById.get(landId);
  if (!land) {
    return [];
  }
  const seas: MesoRegionId[] = [];
  for (const neighbor of land.neighbors) {
    const neighborMeso = mesoById.get(neighbor.id);
    if (neighborMeso && neighborMeso.type === "sea") {
      seas.push(neighbor.id);
    }
  }
  return seas;
}

function uniqueIds(ids: MesoRegionId[]): MesoRegionId[] {
  return [...new Set(ids)];
}
