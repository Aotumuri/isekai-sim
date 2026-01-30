import type { WorldState } from "../world-state";
import type { UnitState } from "../unit";
import { getMoveMsPerRegion } from "../movement";
import type {
  MesoRegion,
  MesoRegionBuilding,
  MesoRegionId,
} from "../../worldgen/meso-region";
import type { NationId } from "../../worldgen/nation";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "../war-state";
import {
  getBorderTargetsByNation,
  getMesoById,
  getNeighborsById,
  getOwnerByMesoId,
} from "../world-cache";

export function repositionUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }
  const landUnits = world.units.filter((unit) => unit.domain === "land");
  if (landUnits.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);

  const warAdjacency = buildWarAdjacency(world.wars);
  const occupationByMesoId = world.occupation.mesoById;
  const hasEnemyUnits = (targetId: MesoRegionId, nationId: NationId): boolean => {
    for (const unit of landUnits) {
      if (
        unit.regionId === targetId &&
        unit.nationId !== nationId &&
        isAtWar(nationId, unit.nationId, warAdjacency)
      ) {
        return true;
      }
    }
    return false;
  };
  const liberationTargetsByNationId = collectLiberationTargetsByNation(
    occupationByMesoId,
    ownerByMesoId,
    mesoById,
  );
  const intrusionTargetsByNationId = collectIntrusionTargetsByNation(
    landUnits,
    ownerByMesoId,
    mesoById,
    warAdjacency,
  );
  const occupationTargetsByNationId = collectOccupationTargetsByNation(
    world.mesoRegions,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
  );
  const borderByNationId = getBorderTargetsByNation(world);

  const nationById = new Map<NationId, WorldState["nations"][number]>();
  for (const nation of world.nations) {
    nationById.set(nation.id, nation);
    nation.unitRoles.defenseUnitIds = [];
    nation.unitRoles.occupationUnitIds = [];
  }

  const unitsByNation = new Map<NationId, UnitState[]>();
  for (const unit of landUnits) {
    const list = unitsByNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      unitsByNation.set(unit.nationId, [unit]);
    }
  }

  for (const [nationId, units] of unitsByNation.entries()) {
    const borderTargets = borderByNationId.get(nationId) ?? [];
    const intrusionTargets = intrusionTargetsByNationId.get(nationId) ?? [];
    const liberationTargets = liberationTargetsByNationId.get(nationId) ?? [];
    const occupationTargets = occupationTargetsByNationId.get(nationId) ?? [];
    const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
    const defenseCount = determineDefenseUnitCount(
      orderedUnits.length,
      intrusionTargets.length,
      liberationTargets.length,
      occupationTargets.length,
    );
    const defenseUnits = orderedUnits.slice(0, defenseCount);
    const occupationUnits = orderedUnits.slice(defenseCount);
    const nation = nationById.get(nationId);
    if (nation) {
      nation.unitRoles.defenseUnitIds = defenseUnits.map((unit) => unit.id);
      nation.unitRoles.occupationUnitIds = occupationUnits.map((unit) => unit.id);
    }
    const isBlockedByEnemy = (toId: MesoRegionId): boolean =>
      hasEnemyUnits(toId, nationId);
    repositionNationUnits(
      nationId,
      defenseUnits,
      occupationUnits,
      intrusionTargets,
      liberationTargets,
      borderTargets,
      occupationTargets,
      dtMs,
      mesoById,
      neighborsById,
      ownerByMesoId,
      occupationByMesoId,
      warAdjacency,
      isBlockedByEnemy,
    );
  }
}

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

function repositionNationUnits(
  nationId: NationId,
  defenseUnits: UnitState[],
  occupationUnits: UnitState[],
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  occupationTargets: MesoRegionId[],
  dtMs: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  isBlockedByEnemy: (toId: MesoRegionId) => boolean,
): void {
  assignDefenseTargets(
    defenseUnits,
    nationId,
    intrusionTargets,
    liberationTargets,
    borderTargets,
    mesoById,
    neighborsById,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
  );
  assignOccupationTargets(
    occupationUnits,
    nationId,
    occupationTargets,
    mesoById,
    neighborsById,
    ownerByMesoId,
    warAdjacency,
  );

  const orderedUnits = [...defenseUnits, ...occupationUnits].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  for (const unit of orderedUnits) {
    const useWarPath = shouldUseWarPath(
      unit,
      nationId,
      ownerByMesoId,
      occupationByMesoId,
      mesoById,
      warAdjacency,
    );
    moveUnitTowardTarget(
      unit,
      dtMs,
      neighborsById,
      (id) =>
        useWarPath
          ? isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency)
          : isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
      isBlockedByEnemy,
    );
  }
}

function moveUnitTowardTarget(
  unit: UnitState,
  dtMs: number,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  isBlockedByEnemy: (toId: MesoRegionId) => boolean,
): void {
  if (!unit.moveTargetId || unit.regionId === unit.moveTargetId) {
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return;
  }

  if (!isAllowed(unit.regionId)) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return;
  }

  unit.moveProgressMs += dtMs;
  if (!ensureMoveLeg(unit, neighborsById, isAllowed)) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return;
  }

  const moveMsPerRegion = getMoveMsPerRegion(unit);
  while (unit.moveProgressMs >= moveMsPerRegion) {
    const nextId = unit.moveToId ?? unit.regionId;
    unit.moveProgressMs -= moveMsPerRegion;
    const previousId = unit.regionId;
    unit.regionId = nextId;

    if (nextId !== previousId && isBlockedByEnemy(nextId)) {
      unit.regionId = previousId;
      unit.moveProgressMs = 0;
      return;
    }

    if (unit.regionId === unit.moveTargetId) {
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      return;
    }

    unit.moveFromId = null;
    unit.moveToId = null;
    if (!ensureMoveLeg(unit, neighborsById, isAllowed)) {
      unit.moveTargetId = null;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      return;
    }
  }
}

function findNearestTarget(
  startId: MesoRegionId,
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): MesoRegionId | null {
  if (!isAllowed(startId)) {
    return null;
  }
  if (targetSet.has(startId) && !assignedTargets.has(startId)) {
    return startId;
  }

  const queue: MesoRegionId[] = [startId];
  const visited = new Set<MesoRegionId>([startId]);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        continue;
      }
      if (!isAllowed(neighbor)) {
        continue;
      }
      if (targetSet.has(neighbor) && !assignedTargets.has(neighbor)) {
        return neighbor;
      }
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  return null;
}

function findNextStep(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): MesoRegionId | null {
  const queue: MesoRegionId[] = [startId];
  const previous = new Map<MesoRegionId, MesoRegionId | null>();
  previous.set(startId, null);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (previous.has(neighbor)) {
        continue;
      }
      if (!isAllowed(neighbor)) {
        continue;
      }
      previous.set(neighbor, current);
      if (neighbor === targetId) {
        return resolveFirstStep(startId, targetId, previous);
      }
      queue.push(neighbor);
    }
  }

  return null;
}

function ensureMoveLeg(
  unit: UnitState,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): MesoRegionId | null {
  if (unit.moveFromId === unit.regionId && unit.moveToId) {
    if (isAllowed(unit.moveToId)) {
      return unit.moveToId;
    }
    unit.moveFromId = null;
    unit.moveToId = null;
  }

  const nextStep = findNextStep(unit.regionId, unit.moveTargetId, neighborsById, isAllowed);
  if (!nextStep) {
    return null;
  }

  unit.moveFromId = unit.regionId;
  unit.moveToId = nextStep;
  return nextStep;
}

function resolveFirstStep(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  previous: Map<MesoRegionId, MesoRegionId | null>,
): MesoRegionId | null {
  let current: MesoRegionId = targetId;
  let prev = previous.get(current) ?? null;
  while (prev && prev !== startId) {
    current = prev;
    prev = previous.get(current) ?? null;
  }
  return prev === startId ? current : null;
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

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

interface LandingPlan {
  targetSeaId: MesoRegionId;
  escortTargets: MesoRegionId[];
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

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}

function collectOwnedTargets(
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const targets: MesoRegionId[] = [];
  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (meso && isPassable(meso)) {
      targets.push(mesoId);
    }
  }
  return targets;
}

function collectBuildingTargets(
  nationId: NationId,
  building: MesoRegionBuilding,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const targets: MesoRegionId[] = [];
  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    if (meso.building === building) {
      targets.push(mesoId);
    }
  }
  return targets;
}

function collectIntrusionTargetsByNation(
  units: UnitState[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const targets = new Map<NationId, Set<MesoRegionId>>();
  for (const unit of units) {
    const owner = ownerByMesoId.get(unit.regionId);
    if (!owner || owner === unit.nationId) {
      continue;
    }
    if (!isAtWar(unit.nationId, owner, warAdjacency)) {
      continue;
    }
    const meso = mesoById.get(unit.regionId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    const set = targets.get(owner);
    if (set) {
      set.add(unit.regionId);
    } else {
      targets.set(owner, new Set([unit.regionId]));
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of targets.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

function collectOccupationTargetsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const targets = new Map<NationId, Set<MesoRegionId>>();
  for (const meso of mesoRegions) {
    if (!isPassable(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    if (occupationByMesoId.has(meso.id)) {
      continue;
    }
    const enemies = warAdjacency.get(owner);
    if (!enemies || enemies.size === 0) {
      continue;
    }
    for (const enemyId of enemies) {
      const set = targets.get(enemyId);
      if (set) {
        set.add(meso.id);
      } else {
        targets.set(enemyId, new Set([meso.id]));
      }
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of targets.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

function assignDefenseTargets(
  units: UnitState[],
  nationId: NationId,
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): void {
  if (units.length === 0) {
    return;
  }

  const intrusionList = selectTargetsForUnits(
    intrusionTargets,
    Math.min(units.length, intrusionTargets.length),
    mesoById,
    "even",
  );
  const intrusionSet = new Set(intrusionList);
  const liberationList = selectTargetsForUnits(
    liberationTargets,
    Math.min(units.length, liberationTargets.length),
    mesoById,
    "even",
  );
  const liberationSet = new Set(liberationList);
  const borderList = selectTargetsForUnits(
    borderTargets,
    Math.min(units.length, borderTargets.length),
    mesoById,
    "spread",
  );
  const borderSet = new Set(borderList);
  const ownedTargets = collectOwnedTargets(nationId, mesoById, ownerByMesoId);
  const capitalTargets = collectBuildingTargets(
    nationId,
    "capital",
    mesoById,
    ownerByMesoId,
  );
  const cityTargets = collectBuildingTargets(nationId, "city", mesoById, ownerByMesoId);

  if (
    intrusionSet.size === 0 &&
    liberationSet.size === 0 &&
    borderSet.size === 0 &&
    ownedTargets.length === 0
  ) {
    clearUnitMovement(units);
    return;
  }

  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const assignedTargets = new Set<MesoRegionId>();
  let remainingUnits = orderedUnits;

  if (capitalTargets.length > 0 && remainingUnits.length > 0) {
    const capitalSet = new Set(capitalTargets);
    remainingUnits = keepExistingTargets(
      remainingUnits,
      capitalSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, capitalSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      capitalSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
  }

  if (cityTargets.length > 0 && remainingUnits.length > 0) {
    const cityList = selectTargetsForUnits(
      cityTargets,
      Math.min(remainingUnits.length, cityTargets.length),
      mesoById,
      "even",
    );
    const citySet = new Set(cityList);
    remainingUnits = keepExistingTargets(
      remainingUnits,
      citySet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, citySet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      citySet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
  }

  if (intrusionSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      intrusionSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, intrusionSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      intrusionSet,
      assignedTargets,
      neighborsById,
      (id) => isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency),
    );
  }

  if (liberationSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      liberationSet,
      assignedTargets,
      (id) => isLiberationTarget(id, nationId, ownerByMesoId, occupationByMesoId, mesoById),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, liberationSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      liberationSet,
      assignedTargets,
      neighborsById,
      (id) => isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency),
    );
  }

  if (borderSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      borderSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, borderSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      borderSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
  }

  if (ownedTargets.length > 0 && remainingUnits.length > 0) {
    const interiorTargets = selectTargetsForUnits(
      ownedTargets,
      Math.min(remainingUnits.length, ownedTargets.length),
      mesoById,
      "even",
    );
    const interiorSet = new Set(interiorTargets);
    remainingUnits = keepExistingTargets(
      remainingUnits,
      interiorSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, interiorSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      interiorSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
  }

  if (remainingUnits.length > 0) {
    const stackTargets = pickDefenseStackTargets(
      intrusionTargets,
      liberationTargets,
      borderTargets,
      ownedTargets,
    );
    if (stackTargets.length > 0) {
      assignStackedTargets(remainingUnits, stackTargets);
      remainingUnits = [];
    }
  }

  clearUnitMovement(remainingUnits);
}

function assignOccupationTargets(
  units: UnitState[],
  nationId: NationId,
  occupationTargets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): void {
  if (units.length === 0) {
    return;
  }
  if (occupationTargets.length === 0) {
    clearUnitMovement(units);
    return;
  }

  const targetSet = new Set(occupationTargets);
  const targetList = [...targetSet];
  if (targetSet.size === 0) {
    clearUnitMovement(units);
    return;
  }

  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const assignedTargets = new Set<MesoRegionId>();
  let remainingUnits = orderedUnits;

  remainingUnits = keepExistingTargets(
    remainingUnits,
    targetSet,
    assignedTargets,
    (id) => isEnemyTarget(id, nationId, mesoById, ownerByMesoId, warAdjacency),
  );
  remainingUnits = assignUnitsOnTarget(remainingUnits, targetSet, assignedTargets);
  remainingUnits = assignNearestTargets(
    remainingUnits,
    targetSet,
    assignedTargets,
    neighborsById,
    (id) => isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency),
  );

  if (remainingUnits.length > 0) {
    assignStackedTargets(remainingUnits, targetList);
    remainingUnits = [];
  }

  clearUnitMovement(remainingUnits);
}

function collectLiberationTargetsByNation(
  occupationByMesoId: Map<MesoRegionId, NationId>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [mesoId, occupier] of occupationByMesoId.entries()) {
    const owner = ownerByMesoId.get(mesoId);
    if (!owner || occupier === owner) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    const list = result.get(owner);
    if (list) {
      list.push(mesoId);
    } else {
      result.set(owner, [mesoId]);
    }
  }
  return result;
}

function pickDefenseStackTargets(
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  ownedTargets: MesoRegionId[],
): MesoRegionId[] {
  if (intrusionTargets.length > 0) {
    return intrusionTargets;
  }
  if (liberationTargets.length > 0) {
    return liberationTargets;
  }
  if (borderTargets.length > 0) {
    return borderTargets;
  }
  return ownedTargets;
}

function determineDefenseUnitCount(
  totalUnits: number,
  intrusionCount: number,
  liberationCount: number,
  occupationCount: number,
): number {
  if (totalUnits <= 0) {
    return 0;
  }
  let ratio = 0.4;
  if (intrusionCount > 0) {
    ratio = 0.7;
  } else if (liberationCount > 0) {
    ratio = 0.6;
  } else if (occupationCount > 0) {
    ratio = 0.4;
  } else {
    ratio = 1;
  }
  const minCount = intrusionCount > 0 || liberationCount > 0 || occupationCount > 0 ? 1 : 0;
  return clamp(Math.round(totalUnits * ratio), minCount, totalUnits);
}

function clearUnitMovement(units: UnitState[]): void {
  for (const unit of units) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function keepExistingTargets(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  isTargetStillValid: (id: MesoRegionId) => boolean,
): UnitState[] {
  const remaining: UnitState[] = [];
  for (const unit of units) {
    const targetId = unit.moveTargetId;
    if (!targetId) {
      remaining.push(unit);
      continue;
    }
    if (!targetSet.has(targetId)) {
      remaining.push(unit);
      continue;
    }
    if (!isTargetStillValid(targetId)) {
      remaining.push(unit);
      continue;
    }
    if (assignedTargets.has(targetId)) {
      remaining.push(unit);
      continue;
    }
    assignedTargets.add(targetId);
  }
  return remaining;
}

function assignUnitsOnTarget(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
): UnitState[] {
  const remaining: UnitState[] = [];
  for (const unit of units) {
    if (targetSet.has(unit.regionId) && !assignedTargets.has(unit.regionId)) {
      unit.moveTargetId = unit.regionId;
      unit.moveFromId = null;
      unit.moveToId = null;
      assignedTargets.add(unit.regionId);
    } else {
      remaining.push(unit);
    }
  }
  return remaining;
}

function assignNearestTargets(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): UnitState[] {
  if (targetSet.size === 0 || assignedTargets.size >= targetSet.size) {
    return units;
  }

  const remaining: UnitState[] = [];
  for (const unit of units) {
    if (assignedTargets.size >= targetSet.size) {
      remaining.push(unit);
      continue;
    }
    const target = findNearestTarget(
      unit.regionId,
      targetSet,
      assignedTargets,
      neighborsById,
      isAllowed,
    );
    if (target) {
      unit.moveTargetId = target;
      assignedTargets.add(target);
    } else {
      remaining.push(unit);
    }
  }
  return remaining;
}

function assignStackedTargets(units: UnitState[], targets: MesoRegionId[]): void {
  const orderedTargets = [...targets].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (orderedTargets.length === 0) {
    return;
  }
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const nextTarget = orderedTargets[i % orderedTargets.length];
    if (unit.moveTargetId === nextTarget) {
      continue;
    }
    unit.moveTargetId = nextTarget;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function selectTargetsForUnits(
  targets: MesoRegionId[],
  unitCount: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
  mode: "spread" | "even",
): MesoRegionId[] {
  if (unitCount <= 0) {
    return [];
  }

  const seen = new Set<MesoRegionId>();
  const uniqueTargets: MesoRegionId[] = [];
  for (const target of targets) {
    if (!seen.has(target)) {
      seen.add(target);
      uniqueTargets.push(target);
    }
  }

  if (uniqueTargets.length <= unitCount) {
    return uniqueTargets;
  }

  if (!hasAllCenters(uniqueTargets, mesoById)) {
    return selectEvenlyByIndex(uniqueTargets, unitCount);
  }

  if (mode === "even") {
    return selectEvenlyByAngle(uniqueTargets, unitCount, mesoById);
  }
  return selectSpreadByDistance(uniqueTargets, unitCount, mesoById);
}

function hasAllCenters(
  targets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  for (const target of targets) {
    if (!mesoById.get(target)) {
      return false;
    }
  }
  return true;
}

function selectSpreadByDistance(
  targets: MesoRegionId[],
  unitCount: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  const centers = new Map<MesoRegionId, { x: number; y: number }>();
  for (const target of targets) {
    const meso = mesoById.get(target);
    if (meso) {
      centers.set(target, meso.center);
    }
  }

  let sumX = 0;
  let sumY = 0;
  for (const center of centers.values()) {
    sumX += center.x;
    sumY += center.y;
  }
  const count = centers.size || 1;
  const centroid = { x: sumX / count, y: sumY / count };

  let first = targets[0];
  let bestDist = -1;
  for (const target of targets) {
    const center = centers.get(target);
    if (!center) {
      continue;
    }
    const dist = distanceSq(center, centroid);
    if (dist > bestDist || (dist === bestDist && target < first)) {
      bestDist = dist;
      first = target;
    }
  }

  const selected: MesoRegionId[] = [first];
  const selectedSet = new Set<MesoRegionId>(selected);

  while (selected.length < unitCount) {
    let bestCandidate: MesoRegionId | null = null;
    let bestMinDist = -1;
    for (const target of targets) {
      if (selectedSet.has(target)) {
        continue;
      }
      const center = centers.get(target);
      if (!center) {
        continue;
      }
      let minDist = Number.POSITIVE_INFINITY;
      for (const chosen of selected) {
        const chosenCenter = centers.get(chosen);
        if (!chosenCenter) {
          continue;
        }
        minDist = Math.min(minDist, distanceSq(center, chosenCenter));
      }
      if (
        minDist > bestMinDist ||
        (minDist === bestMinDist && target < (bestCandidate ?? target))
      ) {
        bestMinDist = minDist;
        bestCandidate = target;
      }
    }
    if (!bestCandidate) {
      break;
    }
    selected.push(bestCandidate);
    selectedSet.add(bestCandidate);
  }

  return selected;
}

function selectEvenlyByIndex(
  targets: MesoRegionId[],
  unitCount: number,
): MesoRegionId[] {
  const step = targets.length / unitCount;
  const used = new Set<number>();
  const selected: MesoRegionId[] = [];

  for (let i = 0; i < unitCount; i += 1) {
    const raw = Math.floor((i + 0.5) * step);
    let index = clamp(raw, 0, targets.length - 1);
    while (used.has(index)) {
      index = (index + 1) % targets.length;
    }
    used.add(index);
    selected.push(targets[index]);
  }

  return selected;
}

function selectEvenlyByAngle(
  targets: MesoRegionId[],
  unitCount: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  const centers = new Map<MesoRegionId, { x: number; y: number }>();
  for (const target of targets) {
    const meso = mesoById.get(target);
    if (meso) {
      centers.set(target, meso.center);
    }
  }

  let sumX = 0;
  let sumY = 0;
  for (const center of centers.values()) {
    sumX += center.x;
    sumY += center.y;
  }
  const count = centers.size || 1;
  const centroid = { x: sumX / count, y: sumY / count };

  const ordered = targets
    .map((target) => {
      const center = centers.get(target) ?? centroid;
      const angle = Math.atan2(center.y - centroid.y, center.x - centroid.x);
      const radius = distanceSq(center, centroid);
      return { target, angle, radius };
    })
    .sort((a, b) => {
      if (a.angle !== b.angle) {
        return a.angle - b.angle;
      }
      if (a.radius !== b.radius) {
        return a.radius - b.radius;
      }
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
    })
    .map((entry) => entry.target);

  return selectEvenlyByIndex(ordered, unitCount);
}

function distanceSq(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isOwnedPassable(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (ownerByMesoId.get(id) !== nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

function isPassableForNation(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner) {
    return false;
  }
  const meso = mesoById.get(id);
  if (!meso || !isPassable(meso)) {
    return false;
  }
  if (owner === nationId) {
    return true;
  }
  return isAtWar(nationId, owner, warAdjacency);
}

function isEnemyTarget(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner || owner === nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  if (!meso || !isPassable(meso)) {
    return false;
  }
  return isAtWar(nationId, owner, warAdjacency);
}

function isLiberationTarget(
  id: MesoRegionId,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner || owner !== nationId) {
    return false;
  }
  const occupier = occupationByMesoId.get(id);
  if (!occupier || occupier === nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

function shouldUseWarPath(
  unit: UnitState,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): boolean {
  const targetId = unit.moveTargetId;
  if (targetId) {
    if (isEnemyTarget(targetId, nationId, mesoById, ownerByMesoId, warAdjacency)) {
      return true;
    }
    if (
      isLiberationTarget(targetId, nationId, ownerByMesoId, occupationByMesoId, mesoById)
    ) {
      return true;
    }
  }

  const owner = ownerByMesoId.get(unit.regionId);
  if (owner && owner !== nationId) {
    return isAtWar(nationId, owner, warAdjacency);
  }

  const occupier = occupationByMesoId.get(unit.regionId);
  if (occupier && occupier !== nationId) {
    return true;
  }

  return false;
}
