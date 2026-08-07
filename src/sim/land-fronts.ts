import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import type { WarState } from "./war-state";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type FrontId = string & { __brand: "FrontId" };

export interface LandFront {
  id: FrontId;
  nationId: NationId;
  enemyNationId: NationId;
  friendlyBorderRegionIds: MesoRegionId[];
  enemyBorderRegionIds: MesoRegionId[];
  friendlyInfluenceRegionIds: MesoRegionId[];
  enemyInfluenceRegionIds: MesoRegionId[];
  friendlyUnitIds: UnitId[];
  enemyUnitIds: UnitId[];
  friendlyStrength: number;
  enemyStrength: number;
  strengthRatio: number;
  friendlyUnitCount: number;
  enemyUnitCount: number;
  borderLength: number;
  nearbyFriendlyCityCount: number;
  hasNearbyFriendlyCapital: boolean;
  nearbyEnemyCityCount: number;
  hasNearbyEnemyCapital: boolean;
  createdAtTick: number;
}

export interface LandFrontState {
  fronts: LandFront[];
  frontsByNationId: Map<NationId, LandFront[]>;
  version: number;
  territoryVersion: number;
  occupationVersion: number;
  warsReference: WarState[] | null;
  warCount: number;
  unitsReference: UnitState[] | null;
  unitIdCounter: number;
  landUnitCount: number;
  lastMetricsFastTick: number;
}

interface BorderContact {
  regionAId: MesoRegionId;
  regionBId: MesoRegionId;
}

interface NationPairContacts {
  nationAId: NationId;
  nationBId: NationId;
  regionIds: Set<MesoRegionId>;
  contacts: BorderContact[];
}

export function createLandFrontState(): LandFrontState {
  return {
    fronts: [],
    frontsByNationId: new Map(),
    version: 0,
    territoryVersion: -1,
    occupationVersion: -1,
    warsReference: null,
    warCount: -1,
    unitsReference: null,
    unitIdCounter: -1,
    landUnitCount: -1,
    lastMetricsFastTick: Number.NEGATIVE_INFINITY,
  };
}

export function updateLandFronts(world: WorldState): void {
  const state = world.landFronts;
  const geometryChanged =
    state.territoryVersion !== world.territoryVersion ||
    state.occupationVersion !== world.occupation.version ||
    state.warsReference !== world.wars ||
    state.warCount !== world.wars.length;

  if (geometryChanged) {
    rebuildLandFronts(world);
    return;
  }

  const landUnitCount = countLandUnits(world.units);
  const unitsChanged =
    state.unitsReference !== world.units ||
    state.unitIdCounter !== world.unitIdCounter ||
    state.landUnitCount !== landUnitCount;
  const refreshInterval = Math.max(
    1,
    Math.round(WORLD_BALANCE.war.landFront.metricsRefreshIntervalTicks),
  );
  const metricsDue = world.time.fastTick - state.lastMetricsFastTick >= refreshInterval;
  if (!unitsChanged && !metricsDue) {
    return;
  }

  const startedAt = world.instrumentation ? performance.now() : 0;
  refreshLandFrontMetrics(world, landUnitCount);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "landFront.metrics",
      performance.now() - startedAt,
    );
    world.instrumentation.incrementCounter("landFront.metricRefreshes");
  }
}

export function getLandFrontsForNation(
  world: WorldState,
  nationId: NationId,
): readonly LandFront[] {
  return world.landFronts.frontsByNationId.get(nationId) ?? [];
}

export function formatLandFrontSummary(
  world: WorldState,
  options: { includeRegionIds?: boolean } = {},
): string {
  const includeRegionIds = options.includeRegionIds ?? false;
  const lines: string[] = [];
  for (const front of world.landFronts.fronts) {
    lines.push(
      `${front.nationId} vs ${front.enemyNationId}`,
      `${front.id}`,
      `  friendly regions: ${front.friendlyBorderRegionIds.length}`,
      `  enemy regions: ${front.enemyBorderRegionIds.length}`,
      `  units: ${front.friendlyUnitCount} vs ${front.enemyUnitCount}`,
      `  strength: ${front.friendlyStrength.toFixed(1)} vs ${front.enemyStrength.toFixed(1)}`,
    );
    if (includeRegionIds) {
      lines.push(
        `  friendly IDs: ${front.friendlyBorderRegionIds.join(", ")}`,
        `  enemy IDs: ${front.enemyBorderRegionIds.join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

function rebuildLandFronts(world: WorldState): void {
  const state = world.landFronts;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousById = new Map(state.fronts.map((front) => [front.id, front]));
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const activeNationIds = new Set(
    world.nations.filter(isNationActive).map((nation) => nation.id),
  );
  const effectiveControllerByMesoId = buildEffectiveControllerByMesoId(
    world.mesoRegions,
    ownerByMesoId,
    world.occupation.mesoById,
  );
  const warAdjacency = buildWarAdjacency(world.wars);
  const contactsByPair = collectWarBorderContacts(
    world.mesoRegions,
    mesoById,
    neighborsById,
    effectiveControllerByMesoId,
    activeNationIds,
    warAdjacency,
  );
  const fronts: LandFront[] = [];

  for (const contacts of [...contactsByPair.values()].sort(comparePairContacts)) {
    const components = splitContactComponents(contacts, neighborsById);
    for (const component of components) {
      const sideA = [...component].filter(
        (id) => effectiveControllerByMesoId.get(id) === contacts.nationAId,
      );
      const sideB = [...component].filter(
        (id) => effectiveControllerByMesoId.get(id) === contacts.nationBId,
      );
      if (sideA.length === 0 || sideB.length === 0) {
        continue;
      }
      sideA.sort(compareIds);
      sideB.sort(compareIds);
      const borderLength = countComponentContacts(component, contacts.contacts);
      const influenceDistance = Math.max(
        0,
        Math.round(WORLD_BALANCE.war.landFront.influenceDistance),
      );
      const influenceA = collectInfluenceRegionIds(
        sideA,
        contacts.nationAId,
        influenceDistance,
        neighborsById,
        effectiveControllerByMesoId,
      );
      const influenceB = collectInfluenceRegionIds(
        sideB,
        contacts.nationBId,
        influenceDistance,
        neighborsById,
        effectiveControllerByMesoId,
      );
      const buildingsA = collectNearbyBuildings(influenceA, mesoById);
      const buildingsB = collectNearbyBuildings(influenceB, mesoById);
      fronts.push(
        createDirectedFront(
          contacts.nationAId,
          contacts.nationBId,
          sideA,
          sideB,
          influenceA,
          influenceB,
          buildingsA,
          buildingsB,
          borderLength,
          previousById,
          world.time.fastTick,
        ),
        createDirectedFront(
          contacts.nationBId,
          contacts.nationAId,
          sideB,
          sideA,
          influenceB,
          influenceA,
          buildingsB,
          buildingsA,
          borderLength,
          previousById,
          world.time.fastTick,
        ),
      );
    }
  }

  fronts.sort(compareFronts);
  state.fronts = fronts;
  state.frontsByNationId = indexFrontsByNation(fronts);
  state.version += 1;
  state.territoryVersion = world.territoryVersion;
  state.occupationVersion = world.occupation.version;
  state.warsReference = world.wars;
  state.warCount = world.wars.length;
  refreshLandFrontMetrics(world, countLandUnits(world.units));

  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "landFront.rebuild",
      performance.now() - startedAt,
    );
    world.instrumentation.incrementCounter("landFront.rebuilds");
    world.instrumentation.incrementCounter("landFront.frontsBuilt", fronts.length);
  }
}

function buildEffectiveControllerByMesoId(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<MesoRegionId, NationId> {
  const controllers = new Map<MesoRegionId, NationId>();
  for (const meso of mesoRegions) {
    if (!isLandNode(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    controllers.set(meso.id, occupier && occupier !== owner ? occupier : owner);
  }
  return controllers;
}

function collectWarBorderContacts(
  mesoRegions: MesoRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  controllerByMesoId: Map<MesoRegionId, NationId>,
  activeNationIds: Set<NationId>,
  warAdjacency: ReturnType<typeof buildWarAdjacency>,
): Map<string, NationPairContacts> {
  const result = new Map<string, NationPairContacts>();
  for (const meso of mesoRegions) {
    if (!isLandNode(meso)) {
      continue;
    }
    const controller = controllerByMesoId.get(meso.id);
    if (!controller || !activeNationIds.has(controller)) {
      continue;
    }
    for (const neighborId of neighborsById.get(meso.id) ?? []) {
      if (compareIds(meso.id, neighborId) >= 0) {
        continue;
      }
      const neighbor = mesoById.get(neighborId);
      if (!neighbor || !isLandNode(neighbor)) {
        continue;
      }
      const neighborController = controllerByMesoId.get(neighborId);
      if (
        !neighborController ||
        controller === neighborController ||
        !activeNationIds.has(neighborController) ||
        !isAtWar(controller, neighborController, warAdjacency)
      ) {
        continue;
      }
      const [nationAId, nationBId, regionAId, regionBId] =
        controller < neighborController
          ? [controller, neighborController, meso.id, neighborId]
          : [neighborController, controller, neighborId, meso.id];
      const key = `${nationAId}::${nationBId}`;
      let pair = result.get(key);
      if (!pair) {
        pair = {
          nationAId,
          nationBId,
          regionIds: new Set(),
          contacts: [],
        };
        result.set(key, pair);
      }
      pair.regionIds.add(regionAId);
      pair.regionIds.add(regionBId);
      pair.contacts.push({ regionAId, regionBId });
    }
  }
  return result;
}

function splitContactComponents(
  contacts: NationPairContacts,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): Set<MesoRegionId>[] {
  const components: Set<MesoRegionId>[] = [];
  const unvisited = new Set(contacts.regionIds);
  const orderedStarts = [...unvisited].sort(compareIds);
  for (const start of orderedStarts) {
    if (!unvisited.delete(start)) {
      continue;
    }
    const component = new Set<MesoRegionId>([start]);
    const queue: MesoRegionId[] = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const neighbor of neighborsById.get(current) ?? []) {
        if (!contacts.regionIds.has(neighbor) || !unvisited.delete(neighbor)) {
          continue;
        }
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function createDirectedFront(
  nationId: NationId,
  enemyNationId: NationId,
  friendlyBorderRegionIds: MesoRegionId[],
  enemyBorderRegionIds: MesoRegionId[],
  friendlyInfluenceRegionIds: MesoRegionId[],
  enemyInfluenceRegionIds: MesoRegionId[],
  friendlyBuildings: { cityCount: number; hasCapital: boolean },
  enemyBuildings: { cityCount: number; hasCapital: boolean },
  borderLength: number,
  previousById: Map<FrontId, LandFront>,
  currentTick: number,
): LandFront {
  const id = createFrontId(
    nationId,
    enemyNationId,
    friendlyBorderRegionIds[0],
    enemyBorderRegionIds[0],
  );
  return {
    id,
    nationId,
    enemyNationId,
    friendlyBorderRegionIds,
    enemyBorderRegionIds,
    friendlyInfluenceRegionIds,
    enemyInfluenceRegionIds,
    friendlyUnitIds: [],
    enemyUnitIds: [],
    friendlyStrength: 0,
    enemyStrength: 0,
    strengthRatio: 0,
    friendlyUnitCount: 0,
    enemyUnitCount: 0,
    borderLength,
    nearbyFriendlyCityCount: friendlyBuildings.cityCount,
    hasNearbyFriendlyCapital: friendlyBuildings.hasCapital,
    nearbyEnemyCityCount: enemyBuildings.cityCount,
    hasNearbyEnemyCapital: enemyBuildings.hasCapital,
    createdAtTick: previousById.get(id)?.createdAtTick ?? currentTick,
  };
}

function collectInfluenceRegionIds(
  borderRegionIds: MesoRegionId[],
  nationId: NationId,
  maxDistance: number,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  controllerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const result = new Set<MesoRegionId>();
  const queue: Array<{ id: MesoRegionId; distance: number }> = [];
  for (const id of borderRegionIds) {
    if (controllerByMesoId.get(id) !== nationId || result.has(id)) {
      continue;
    }
    result.add(id);
    queue.push({ id, distance: 0 });
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current.distance >= maxDistance) {
      continue;
    }
    for (const neighbor of neighborsById.get(current.id) ?? []) {
      if (controllerByMesoId.get(neighbor) !== nationId || result.has(neighbor)) {
        continue;
      }
      result.add(neighbor);
      queue.push({ id: neighbor, distance: current.distance + 1 });
    }
  }
  return [...result].sort(compareIds);
}

function collectNearbyBuildings(
  regionIds: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
): { cityCount: number; hasCapital: boolean } {
  let cityCount = 0;
  let hasCapital = false;
  for (const id of regionIds) {
    const building = mesoById.get(id)?.building;
    if (building === "city") {
      cityCount += 1;
    } else if (building === "capital") {
      hasCapital = true;
    }
  }
  return { cityCount, hasCapital };
}

function refreshLandFrontMetrics(world: WorldState, landUnitCount: number): void {
  const state = world.landFronts;
  const landUnitsByRegion = new Map<MesoRegionId, UnitState[]>();
  for (const unit of world.units) {
    if (unit.domain !== "land") {
      continue;
    }
    const list = landUnitsByRegion.get(unit.regionId);
    if (list) {
      list.push(unit);
    } else {
      landUnitsByRegion.set(unit.regionId, [unit]);
    }
  }

  for (const front of state.fronts) {
    const friendlyUnits = collectUnitsInInfluence(
      front.friendlyInfluenceRegionIds,
      front.nationId,
      landUnitsByRegion,
    );
    const enemyUnits = collectUnitsInInfluence(
      front.enemyInfluenceRegionIds,
      front.enemyNationId,
      landUnitsByRegion,
    );
    front.friendlyUnitIds = friendlyUnits.map((unit) => unit.id).sort(compareIds);
    front.enemyUnitIds = enemyUnits.map((unit) => unit.id).sort(compareIds);
    front.friendlyUnitCount = friendlyUnits.length;
    front.enemyUnitCount = enemyUnits.length;
    front.friendlyStrength = sumFiniteStrength(friendlyUnits);
    front.enemyStrength = sumFiniteStrength(enemyUnits);
    front.strengthRatio = finiteRatio(front.friendlyStrength, front.enemyStrength);
  }

  state.unitsReference = world.units;
  state.unitIdCounter = world.unitIdCounter;
  state.landUnitCount = landUnitCount;
  state.lastMetricsFastTick = world.time.fastTick;
}

function collectUnitsInInfluence(
  influenceRegionIds: MesoRegionId[],
  nationId: NationId,
  unitsByRegion: Map<MesoRegionId, UnitState[]>,
): UnitState[] {
  const result: UnitState[] = [];
  for (const regionId of influenceRegionIds) {
    for (const unit of unitsByRegion.get(regionId) ?? []) {
      if (unit.nationId === nationId) {
        result.push(unit);
      }
    }
  }
  return result;
}

function sumFiniteStrength(units: UnitState[]): number {
  let total = 0;
  for (const unit of units) {
    const strength = getUnitCombatStrength(unit);
    if (Number.isFinite(strength) && strength > 0) {
      total += strength;
    }
  }
  return Number.isFinite(total) ? total : 0;
}

function finiteRatio(friendlyStrength: number, enemyStrength: number): number {
  const ratio = friendlyStrength / Math.max(1, enemyStrength);
  return Number.isFinite(ratio) ? ratio : 0;
}

function countComponentContacts(
  component: Set<MesoRegionId>,
  contacts: BorderContact[],
): number {
  let count = 0;
  for (const contact of contacts) {
    if (component.has(contact.regionAId) && component.has(contact.regionBId)) {
      count += 1;
    }
  }
  return count;
}

function createFrontId(
  nationId: NationId,
  enemyNationId: NationId,
  firstFriendlyId: MesoRegionId,
  firstEnemyId: MesoRegionId,
): FrontId {
  return `front-${nationId}-${enemyNationId}-${firstFriendlyId}-${firstEnemyId}` as FrontId;
}

function indexFrontsByNation(fronts: LandFront[]): Map<NationId, LandFront[]> {
  const result = new Map<NationId, LandFront[]>();
  for (const front of fronts) {
    const list = result.get(front.nationId);
    if (list) {
      list.push(front);
    } else {
      result.set(front.nationId, [front]);
    }
  }
  return result;
}

function countLandUnits(units: UnitState[]): number {
  let count = 0;
  for (const unit of units) {
    if (unit.domain === "land") {
      count += 1;
    }
  }
  return count;
}

function comparePairContacts(a: NationPairContacts, b: NationPairContacts): number {
  const nationCompare = compareIds(a.nationAId, b.nationAId);
  return nationCompare !== 0 ? nationCompare : compareIds(a.nationBId, b.nationBId);
}

function compareFronts(a: LandFront, b: LandFront): number {
  const nationCompare = compareIds(a.nationId, b.nationId);
  if (nationCompare !== 0) {
    return nationCompare;
  }
  const enemyCompare = compareIds(a.enemyNationId, b.enemyNationId);
  return enemyCompare !== 0 ? enemyCompare : compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isLandNode(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}
