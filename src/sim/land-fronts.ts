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
/** Sector IDs intentionally remain assignable to FrontId for compatibility
 * with persisted operation/retreat records while the AI migrates one layer
 * below PhysicalFront. */
export type SectorId = FrontId;

export interface FrontBorderEdge {
  regionAId: MesoRegionId;
  regionBId: MesoRegionId;
}

export interface PhysicalFrontSide {
  nationId: NationId;
  borderRegionIds: MesoRegionId[];
  influenceRegionIds: MesoRegionId[];
  unitIds: UnitId[];
  unitCount: number;
  strength: number;
  nearbyCityCount: number;
  hasNearbyCapital: boolean;
}

/**
 * Objective geometry and metrics for one physical A-B border component.
 * Nation-specific strategy belongs in NationFrontPlan, never in this record.
 */
export interface PhysicalFront {
  id: FrontId;
  nationAId: NationId;
  nationBId: NationId;
  sideA: PhysicalFrontSide;
  sideB: PhysicalFrontSide;
  borderEdges: FrontBorderEdge[];
  borderLength: number;
  createdAtTick: number;
}

export interface Frontline {
  /** The exact hostile adjacency cells represented by this sector. */
  borderEdges: FrontBorderEdge[];
  sideARegionIds: MesoRegionId[];
  sideBRegionIds: MesoRegionId[];
}

/** A stable, local command area within one PhysicalFront. */
export interface OperationalSector {
  id: SectorId;
  physicalFrontId: FrontId;
  nationAId: NationId;
  nationBId: NationId;
  sideA: PhysicalFrontSide;
  sideB: PhysicalFrontSide;
  borderEdges: FrontBorderEdge[];
  borderLength: number;
  frontline: Frontline;
  createdAtTick: number;
}

export interface LandFrontState {
  physicalFronts: PhysicalFront[];
  physicalFrontsById: Map<FrontId, PhysicalFront>;
  physicalFrontsByNationId: Map<NationId, PhysicalFront[]>;
  operationalSectors: OperationalSector[];
  operationalSectorsById: Map<SectorId, OperationalSector>;
  operationalSectorsByFrontId: Map<FrontId, OperationalSector[]>;
  operationalSectorsByNationId: Map<NationId, OperationalSector[]>;
  version: number;
  metricsVersion: number;
  territoryVersion: number;
  occupationVersion: number;
  buildingVersion: number;
  warsReference: WarState[] | null;
  warCount: number;
  unitsReference: UnitState[] | null;
  unitIdCounter: number;
  landUnitCount: number;
  lastMetricsFastTick: number;
}

interface NationPairContacts {
  nationAId: NationId;
  nationBId: NationId;
  regionIds: Set<MesoRegionId>;
  contacts: FrontBorderEdge[];
}

export function createLandFrontState(): LandFrontState {
  return {
    physicalFronts: [],
    physicalFrontsById: new Map(),
    physicalFrontsByNationId: new Map(),
    operationalSectors: [],
    operationalSectorsById: new Map(),
    operationalSectorsByFrontId: new Map(),
    operationalSectorsByNationId: new Map(),
    version: 0,
    metricsVersion: 0,
    territoryVersion: -1,
    occupationVersion: -1,
    buildingVersion: -1,
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
  const buildingsChanged = state.buildingVersion !== world.buildingVersion;
  const unitsChanged =
    state.unitsReference !== world.units ||
    state.unitIdCounter !== world.unitIdCounter ||
    state.landUnitCount !== landUnitCount;
  const refreshInterval = Math.max(
    1,
    Math.round(WORLD_BALANCE.war.landFront.metricsRefreshIntervalTicks),
  );
  const metricsDue = world.time.fastTick - state.lastMetricsFastTick >= refreshInterval;
  if (!buildingsChanged && !unitsChanged && !metricsDue) {
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

export function getPhysicalFronts(world: WorldState): readonly PhysicalFront[] {
  return world.landFronts.physicalFronts;
}

export function getPhysicalFront(
  world: WorldState,
  frontId: FrontId,
): PhysicalFront | undefined {
  return world.landFronts.physicalFrontsById.get(frontId);
}

export function getPhysicalFrontsForNation(
  world: WorldState,
  nationId: NationId,
): readonly PhysicalFront[] {
  return world.landFronts.physicalFrontsByNationId.get(nationId) ?? [];
}

export function getOperationalSectors(
  world: WorldState,
): readonly OperationalSector[] {
  return world.landFronts.operationalSectors;
}

export function getOperationalSector(
  world: WorldState,
  sectorId: SectorId,
): OperationalSector | undefined {
  return world.landFronts.operationalSectorsById.get(sectorId);
}

export function getOperationalSectorsForFront(
  world: WorldState,
  frontId: FrontId,
): readonly OperationalSector[] {
  return world.landFronts.operationalSectorsByFrontId.get(frontId) ?? [];
}

export function getOperationalSectorsForNation(
  world: WorldState,
  nationId: NationId,
): readonly OperationalSector[] {
  return world.landFronts.operationalSectorsByNationId.get(nationId) ?? [];
}

export function getFrontSide(
  front: PhysicalFront | OperationalSector,
  nationId: NationId,
): PhysicalFrontSide | undefined {
  if (front.nationAId === nationId) {
    return front.sideA;
  }
  if (front.nationBId === nationId) {
    return front.sideB;
  }
  return undefined;
}

export function getOpposingFrontSide(
  front: PhysicalFront | OperationalSector,
  nationId: NationId,
): PhysicalFrontSide | undefined {
  if (front.nationAId === nationId) {
    return front.sideB;
  }
  if (front.nationBId === nationId) {
    return front.sideA;
  }
  return undefined;
}

export function formatLandFrontSummary(
  world: WorldState,
  options: { includeRegionIds?: boolean } = {},
): string {
  const includeRegionIds = options.includeRegionIds ?? false;
  const lines: string[] = [];
  for (const front of world.landFronts.physicalFronts) {
    lines.push(
      `${front.nationAId} - ${front.nationBId}`,
      `${front.id}`,
      `  border regions: ${front.sideA.borderRegionIds.length} vs ${front.sideB.borderRegionIds.length}`,
      `  border edges: ${front.borderLength}`,
      `  units: ${front.sideA.unitCount} vs ${front.sideB.unitCount}`,
      `  strength: ${front.sideA.strength.toFixed(1)} vs ${front.sideB.strength.toFixed(1)}`,
    );
    if (includeRegionIds) {
      lines.push(
        `  side A IDs: ${front.sideA.borderRegionIds.join(", ")}`,
        `  side B IDs: ${front.sideB.borderRegionIds.join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

function rebuildLandFronts(world: WorldState): void {
  const state = world.landFronts;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousById = state.physicalFrontsById;
  const previousSectors = state.operationalSectors;
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
  const physicalFronts: PhysicalFront[] = [];

  for (const contacts of [...contactsByPair.values()].sort(comparePairContacts)) {
    const components = splitContactComponents(contacts, neighborsById);
    for (const component of components) {
      const sideARegionIds = [...component]
        .filter(
          (id) => effectiveControllerByMesoId.get(id) === contacts.nationAId,
        )
        .sort(compareIds);
      const sideBRegionIds = [...component]
        .filter(
          (id) => effectiveControllerByMesoId.get(id) === contacts.nationBId,
        )
        .sort(compareIds);
      if (sideARegionIds.length === 0 || sideBRegionIds.length === 0) {
        continue;
      }

      const influenceDistance = Math.max(
        0,
        Math.round(WORLD_BALANCE.war.landFront.influenceDistance),
      );
      const influenceA = collectInfluenceRegionIds(
        sideARegionIds,
        contacts.nationAId,
        influenceDistance,
        neighborsById,
        effectiveControllerByMesoId,
      );
      const influenceB = collectInfluenceRegionIds(
        sideBRegionIds,
        contacts.nationBId,
        influenceDistance,
        neighborsById,
        effectiveControllerByMesoId,
      );
      const borderEdges = collectComponentBorderEdges(component, contacts.contacts);
      const id = createFrontId(
        contacts.nationAId,
        contacts.nationBId,
        sideARegionIds[0],
        sideBRegionIds[0],
      );
      physicalFronts.push({
        id,
        nationAId: contacts.nationAId,
        nationBId: contacts.nationBId,
        sideA: createPhysicalFrontSide(
          contacts.nationAId,
          sideARegionIds,
          influenceA,
          mesoById,
        ),
        sideB: createPhysicalFrontSide(
          contacts.nationBId,
          sideBRegionIds,
          influenceB,
          mesoById,
        ),
        borderEdges,
        borderLength: borderEdges.length,
        createdAtTick: previousById.get(id)?.createdAtTick ?? world.time.fastTick,
      });
    }
  }

  physicalFronts.sort(comparePhysicalFronts);
  const operationalSectors = buildOperationalSectors(
    world,
    physicalFronts,
    previousSectors,
    effectiveControllerByMesoId,
  );
  state.physicalFronts = physicalFronts;
  state.physicalFrontsById = new Map(
    physicalFronts.map((front) => [front.id, front]),
  );
  state.physicalFrontsByNationId = indexPhysicalFrontsByNation(physicalFronts);
  state.operationalSectors = operationalSectors;
  state.operationalSectorsById = new Map(
    operationalSectors.map((sector) => [sector.id, sector]),
  );
  state.operationalSectorsByFrontId = indexSectorsByFront(operationalSectors);
  state.operationalSectorsByNationId = indexSectorsByNation(operationalSectors);
  state.version += 1;
  state.territoryVersion = world.territoryVersion;
  state.occupationVersion = world.occupation.version;
  state.buildingVersion = world.buildingVersion;
  state.warsReference = world.wars;
  state.warCount = world.wars.length;
  refreshLandFrontMetrics(world, countLandUnits(world.units));

  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "landFront.rebuild",
      performance.now() - startedAt,
    );
    world.instrumentation.incrementCounter("landFront.rebuilds");
    world.instrumentation.incrementCounter(
      "landFront.frontsBuilt",
      physicalFronts.length,
    );
    world.instrumentation.incrementCounter(
      "landFront.sectorsBuilt",
      operationalSectors.length,
    );
  }
}

function createPhysicalFrontSide(
  nationId: NationId,
  borderRegionIds: MesoRegionId[],
  influenceRegionIds: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
): PhysicalFrontSide {
  const buildings = collectNearbyBuildings(influenceRegionIds, mesoById);
  return {
    nationId,
    borderRegionIds,
    influenceRegionIds,
    unitIds: [],
    unitCount: 0,
    strength: 0,
    nearbyCityCount: buildings.cityCount,
    hasNearbyCapital: buildings.hasCapital,
  };
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

function collectInfluenceRegionIds(
  borderRegionIds: MesoRegionId[],
  nationId: NationId,
  maxDistance: number,
  neighborsById: ReadonlyMap<MesoRegionId, MesoRegionId[]>,
  controllerByMesoId: ReadonlyMap<MesoRegionId, NationId>,
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
  const mesoById = getMesoById(world);
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

  const refreshedSides = new Set<PhysicalFrontSide>();
  for (const front of state.physicalFronts) {
    refreshFrontSideMetrics(front.sideA, landUnitsByRegion, mesoById);
    refreshFrontSideMetrics(front.sideB, landUnitsByRegion, mesoById);
    refreshedSides.add(front.sideA);
    refreshedSides.add(front.sideB);
  }
  for (const sector of state.operationalSectors) {
    if (!refreshedSides.has(sector.sideA)) {
      refreshFrontSideMetrics(sector.sideA, landUnitsByRegion, mesoById);
    }
    if (!refreshedSides.has(sector.sideB)) {
      refreshFrontSideMetrics(sector.sideB, landUnitsByRegion, mesoById);
    }
  }

  state.unitsReference = world.units;
  state.unitIdCounter = world.unitIdCounter;
  state.landUnitCount = landUnitCount;
  state.lastMetricsFastTick = world.time.fastTick;
  state.buildingVersion = world.buildingVersion;
  state.metricsVersion += 1;
}

function refreshFrontSideMetrics(
  side: PhysicalFrontSide,
  unitsByRegion: Map<MesoRegionId, UnitState[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): void {
  const units = collectUnitsInInfluence(
    side.influenceRegionIds,
    side.nationId,
    unitsByRegion,
  );
  side.unitIds = units.map((unit) => unit.id).sort(compareIds);
  side.unitCount = units.length;
  side.strength = sumFiniteStrength(units);
  const buildings = collectNearbyBuildings(side.influenceRegionIds, mesoById);
  side.nearbyCityCount = buildings.cityCount;
  side.hasNearbyCapital = buildings.hasCapital;
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

function collectComponentBorderEdges(
  component: Set<MesoRegionId>,
  contacts: FrontBorderEdge[],
): FrontBorderEdge[] {
  return contacts
    .filter(
      (contact) =>
        component.has(contact.regionAId) && component.has(contact.regionBId),
    )
    .sort((a, b) => {
      const sideACompare = compareIds(a.regionAId, b.regionAId);
      return sideACompare !== 0
        ? sideACompare
        : compareIds(a.regionBId, b.regionBId);
    });
}

function buildOperationalSectors(
  world: WorldState,
  fronts: PhysicalFront[],
  previousSectors: readonly OperationalSector[],
  controllerByMesoId: ReadonlyMap<MesoRegionId, NationId>,
): OperationalSector[] {
  const settings = WORLD_BALANCE.war.landFront.sector;
  const neighborsById = getNeighborsById(world);
  const mesoById = getMesoById(world);
  const previousByPair = new Map<string, OperationalSector[]>();
  for (const sector of previousSectors) {
    const key = `${sector.nationAId}::${sector.nationBId}`;
    const list = previousByPair.get(key);
    if (list) list.push(sector);
    else previousByPair.set(key, [sector]);
  }
  const usedPreviousIds = new Set<SectorId>();
  const sectors: OperationalSector[] = [];

  for (const front of fronts) {
    const clusters = splitBorderEdgeGraph(
      front.borderEdges,
      neighborsById,
      Math.max(2, Math.round(settings.maximumGraphDiameter)),
      Math.max(1, Math.round(settings.minimumBorderEdges)),
    );
    const previousCandidates = previousByPair.get(
      `${front.nationAId}::${front.nationBId}`,
    ) ?? [];
    for (const edges of clusters) {
      const sideARegionIds = uniqueSorted(edges.map((edge) => edge.regionAId));
      const sideBRegionIds = uniqueSorted(edges.map((edge) => edge.regionBId));
      const previous = findBestPreviousSector(
        edges,
        previousCandidates,
        usedPreviousIds,
      );
      const id = previous?.id ?? (
        clusters.length === 1
          ? front.id
          : createSectorId(front.nationAId, front.nationBId, edges[0])
      );
      if (previous) usedPreviousIds.add(previous.id);
      let sideA = front.sideA;
      let sideB = front.sideB;
      if (clusters.length > 1) {
        const influenceDistance = Math.max(
          0,
          Math.round(WORLD_BALANCE.war.landFront.influenceDistance),
        );
        const influenceA = collectInfluenceRegionIds(
          sideARegionIds,
          front.nationAId,
          influenceDistance,
          neighborsById,
          controllerByMesoId,
        );
        const influenceB = collectInfluenceRegionIds(
          sideBRegionIds,
          front.nationBId,
          influenceDistance,
          neighborsById,
          controllerByMesoId,
        );
        sideA = createPhysicalFrontSide(front.nationAId, sideARegionIds, influenceA, mesoById);
        sideB = createPhysicalFrontSide(front.nationBId, sideBRegionIds, influenceB, mesoById);
      }
      sectors.push({
        id,
        physicalFrontId: front.id,
        nationAId: front.nationAId,
        nationBId: front.nationBId,
        sideA,
        sideB,
        borderEdges: edges,
        borderLength: edges.length,
        frontline: {
          borderEdges: edges,
          sideARegionIds,
          sideBRegionIds,
        },
        createdAtTick: previous?.createdAtTick ?? world.time.fastTick,
      });
    }
  }
  return sectors.sort((a, b) => compareIds(a.id, b.id));
}

/**
 * Recursively bisects the border-edge adjacency graph only when its geodesic
 * diameter is too large. Two farthest endpoints become deterministic seeds;
 * every edge joins its nearer seed. This follows bends, branches and narrow
 * joins instead of slicing an arbitrary sorted region list every N entries.
 */
function splitBorderEdgeGraph(
  edges: readonly FrontBorderEdge[],
  neighborsById: ReadonlyMap<MesoRegionId, MesoRegionId[]>,
  maximumDiameter: number,
  minimumEdges: number,
): FrontBorderEdge[][] {
  if (edges.length <= minimumEdges * 2) return [[...edges]];
  const adjacency = buildBorderEdgeAdjacency(edges, neighborsById);
  const queue: number[][] = [edges.map((_, index) => index)];
  const finished: number[][] = [];
  while (queue.length > 0) {
    const cluster = queue.shift();
    if (!cluster) break;
    const allowed = new Set(cluster);
    const first = farthestEdge(cluster[0], allowed, adjacency);
    const second = farthestEdge(first.index, allowed, adjacency);
    if (second.distance <= maximumDiameter || cluster.length < minimumEdges * 2) {
      finished.push(cluster);
      continue;
    }
    const fromFirst = edgeDistances(first.index, allowed, adjacency);
    const fromSecond = edgeDistances(second.index, allowed, adjacency);
    const left: number[] = [];
    const right: number[] = [];
    for (const index of cluster) {
      const a = fromFirst.get(index) ?? Infinity;
      const b = fromSecond.get(index) ?? Infinity;
      (a < b || (a === b && compareBorderEdges(edges[index], edges[first.index]) <= 0)
        ? left
        : right).push(index);
    }
    if (left.length < minimumEdges || right.length < minimumEdges) {
      finished.push(cluster);
    } else {
      queue.push(left, right);
    }
  }
  return finished
    .map((indices) => indices.map((index) => edges[index]).sort(compareBorderEdges))
    .sort((a, b) => compareBorderEdges(a[0], b[0]));
}

function buildBorderEdgeAdjacency(
  edges: readonly FrontBorderEdge[],
  neighborsById: ReadonlyMap<MesoRegionId, MesoRegionId[]>,
): number[][] {
  const indicesByRegion = new Map<MesoRegionId, number[]>();
  edges.forEach((edge, index) => {
    for (const id of [edge.regionAId, edge.regionBId]) {
      const list = indicesByRegion.get(id);
      if (list) list.push(index);
      else indicesByRegion.set(id, [index]);
    }
  });
  const adjacency = edges.map(() => new Set<number>());
  edges.forEach((edge, index) => {
    const nearby = new Set<MesoRegionId>([edge.regionAId, edge.regionBId]);
    for (const id of [edge.regionAId, edge.regionBId]) {
      for (const neighbor of neighborsById.get(id) ?? []) nearby.add(neighbor);
    }
    for (const id of nearby) {
      for (const other of indicesByRegion.get(id) ?? []) {
        if (other !== index) adjacency[index].add(other);
      }
    }
  });
  return adjacency.map((items) => [...items].sort((a, b) => a - b));
}

function edgeDistances(
  source: number,
  allowed: ReadonlySet<number>,
  adjacency: readonly number[][],
): Map<number, number> {
  const distances = new Map<number, number>([[source, 0]]);
  const queue = [source];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const next of adjacency[current] ?? []) {
      if (!allowed.has(next) || distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function farthestEdge(
  source: number,
  allowed: ReadonlySet<number>,
  adjacency: readonly number[][],
): { index: number; distance: number } {
  const distances = edgeDistances(source, allowed, adjacency);
  let result = { index: source, distance: 0 };
  for (const index of [...allowed].sort((a, b) => a - b)) {
    const distance = distances.get(index) ?? 0;
    if (distance > result.distance || (distance === result.distance && index < result.index)) {
      result = { index, distance };
    }
  }
  return result;
}

function findBestPreviousSector(
  edges: readonly FrontBorderEdge[],
  candidates: readonly OperationalSector[],
  usedIds: ReadonlySet<SectorId>,
): OperationalSector | undefined {
  const keys = new Set(edges.map(borderEdgeKey));
  let best: OperationalSector | undefined;
  let bestOverlap = 0;
  for (const candidate of candidates) {
    if (usedIds.has(candidate.id)) continue;
    let overlap = 0;
    for (const edge of candidate.borderEdges) {
      if (keys.has(borderEdgeKey(edge))) overlap += 1;
    }
    if (overlap > bestOverlap || (overlap === bestOverlap && overlap > 0 && best && compareIds(candidate.id, best.id) < 0)) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return bestOverlap > 0 ? best : undefined;
}

function createSectorId(
  nationAId: NationId,
  nationBId: NationId,
  edge: FrontBorderEdge,
): SectorId {
  return `sector-${nationAId}-${nationBId}-${edge.regionAId}-${edge.regionBId}` as SectorId;
}

function borderEdgeKey(edge: FrontBorderEdge): string {
  return `${edge.regionAId}::${edge.regionBId}`;
}

function compareBorderEdges(a: FrontBorderEdge, b: FrontBorderEdge): number {
  return compareIds(a.regionAId, b.regionAId) || compareIds(a.regionBId, b.regionBId);
}

function uniqueSorted(ids: readonly MesoRegionId[]): MesoRegionId[] {
  return [...new Set(ids)].sort(compareIds);
}

function indexSectorsByFront(
  sectors: readonly OperationalSector[],
): Map<FrontId, OperationalSector[]> {
  const result = new Map<FrontId, OperationalSector[]>();
  for (const sector of sectors) {
    const list = result.get(sector.physicalFrontId);
    if (list) list.push(sector);
    else result.set(sector.physicalFrontId, [sector]);
  }
  return result;
}

function indexSectorsByNation(
  sectors: readonly OperationalSector[],
): Map<NationId, OperationalSector[]> {
  const result = new Map<NationId, OperationalSector[]>();
  for (const sector of sectors) {
    addSectorToNationIndex(result, sector.nationAId, sector);
    addSectorToNationIndex(result, sector.nationBId, sector);
  }
  return result;
}

function addSectorToNationIndex(
  index: Map<NationId, OperationalSector[]>,
  nationId: NationId,
  sector: OperationalSector,
): void {
  const list = index.get(nationId);
  if (list) list.push(sector);
  else index.set(nationId, [sector]);
}

function createFrontId(
  nationAId: NationId,
  nationBId: NationId,
  firstSideAId: MesoRegionId,
  firstSideBId: MesoRegionId,
): FrontId {
  return `front-${nationAId}-${nationBId}-${firstSideAId}-${firstSideBId}` as FrontId;
}

function indexPhysicalFrontsByNation(
  physicalFronts: PhysicalFront[],
): Map<NationId, PhysicalFront[]> {
  const result = new Map<NationId, PhysicalFront[]>();
  for (const front of physicalFronts) {
    addFrontToNationIndex(result, front.nationAId, front);
    addFrontToNationIndex(result, front.nationBId, front);
  }
  return result;
}

function addFrontToNationIndex(
  index: Map<NationId, PhysicalFront[]>,
  nationId: NationId,
  front: PhysicalFront,
): void {
  const list = index.get(nationId);
  if (list) {
    list.push(front);
  } else {
    index.set(nationId, [front]);
  }
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

function comparePhysicalFronts(a: PhysicalFront, b: PhysicalFront): number {
  return compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isLandNode(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}
