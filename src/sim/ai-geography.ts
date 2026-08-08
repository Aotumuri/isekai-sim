import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { FrontId, OperationalSector } from "./land-fronts";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export interface ControlledTopology {
  nationId: NationId;
  territoryVersion: number;
  occupationVersion: number;
  controlledRegionIds: Set<MesoRegionId>;
  componentByRegionId: Map<MesoRegionId, number>;
  regionIdsByComponent: Map<number, MesoRegionId[]>;
}

export interface ControlledDistanceField {
  nationId: NationId;
  territoryVersion: number;
  occupationVersion: number;
  sourceRegionIds: MesoRegionId[];
  distanceByRegionId: Map<MesoRegionId, number>;
}

export interface FrontDistanceField {
  frontId: FrontId;
  nationId: NationId;
  frontVersion: number;
  sourceRegionIds: MesoRegionId[];
  distanceByRegionId: Map<MesoRegionId, number>;
}

export interface SafeRegionState {
  generation: number;
  fastTick: number;
  warAdjacency: WarAdjacency;
  battleRegionIds: Set<MesoRegionId>;
  landUnitsByRegionId: Map<
    MesoRegionId,
    Array<{ nationId: NationId; strength: number }>
  >;
  enemyRegionIdsByNationId: Map<NationId, Set<MesoRegionId>>;
  enemyStrengthByRegionByNationId: Map<
    NationId,
    Map<MesoRegionId, number>
  >;
}

export type DynamicSafetyLayer = SafeRegionState;

export interface AiGeographyStatistics {
  topologyRequests: number;
  topologyHits: number;
  topologyRebuilds: number;
  controlledDistanceRequests: number;
  controlledDistanceHits: number;
  controlledDistanceRebuilds: number;
  frontDistanceRequests: number;
  frontDistanceHits: number;
  frontDistanceRebuilds: number;
  safetyRequests: number;
  safetyHits: number;
  safetyRebuilds: number;
}

export interface AiGeographyCacheState {
  topologyTerritoryVersion: number;
  topologyOccupationVersion: number;
  topologyByNationId: Map<NationId, ControlledTopology>;
  controlledDistanceByKey: Map<string, ControlledDistanceField>;
  frontDistanceVersion: number;
  frontDistanceByKey: Map<string, FrontDistanceField>;
  dynamicGeneration: number;
  dynamicSafety: DynamicSafetyLayer | null;
  statistics: AiGeographyStatistics;
}

export function beginAiGeographyEvaluation(world: WorldState): void {
  const state = getAiGeographyState(world);
  state.dynamicGeneration += 1;
  state.dynamicSafety = null;
}

export function getControlledTopology(
  world: WorldState,
  nationId: NationId,
): ControlledTopology {
  const state = getAiGeographyState(world);
  state.statistics.topologyRequests += 1;
  increment(world, "aiGeography.topology.requests");
  if (
    state.topologyTerritoryVersion === world.territoryVersion &&
    state.topologyOccupationVersion === world.occupation.version
  ) {
    state.statistics.topologyHits += 1;
    increment(world, "aiGeography.topology.hits");
    return (
      state.topologyByNationId.get(nationId) ??
      createEmptyControlledTopology(world, nationId)
    );
  }

  const startedAt = world.instrumentation ? performance.now() : 0;
  rebuildControlledTopologies(world, state);
  state.statistics.topologyRebuilds += 1;
  increment(world, "aiGeography.topology.rebuilds");
  record(world, "aiGeography.controlledTopology", startedAt);
  return (
    state.topologyByNationId.get(nationId) ??
    createEmptyControlledTopology(world, nationId)
  );
}

export function getControlledRegions(
  world: WorldState,
  nationId: NationId,
): ReadonlySet<MesoRegionId> {
  return getControlledTopology(world, nationId).controlledRegionIds;
}

export function getConnectedComponent(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
): number | undefined {
  return getControlledTopology(world, nationId).componentByRegionId.get(regionId);
}

export function canReachControlled(
  world: WorldState,
  nationId: NationId,
  fromRegionId: MesoRegionId,
  toRegionId: MesoRegionId,
): boolean {
  const topology = getControlledTopology(world, nationId);
  const fromComponent = topology.componentByRegionId.get(fromRegionId);
  return (
    fromComponent !== undefined &&
    fromComponent === topology.componentByRegionId.get(toRegionId)
  );
}

export function getControlledDistanceField(
  world: WorldState,
  nationId: NationId,
  sourceRegionIds: readonly MesoRegionId[],
): ControlledDistanceField {
  const state = getAiGeographyState(world);
  const topology = getControlledTopology(world, nationId);
  const canonicalSources = [...new Set(sourceRegionIds)].sort(compareIds);
  const key = `${nationId}::${canonicalSources.join(",")}`;
  state.statistics.controlledDistanceRequests += 1;
  increment(world, "aiGeography.controlledDistance.requests");
  const cached = state.controlledDistanceByKey.get(key);
  if (
    cached?.territoryVersion === topology.territoryVersion &&
    cached.occupationVersion === topology.occupationVersion
  ) {
    state.statistics.controlledDistanceHits += 1;
    increment(world, "aiGeography.controlledDistance.hits");
    return cached;
  }

  const startedAt = world.instrumentation ? performance.now() : 0;
  const distances = buildControlledDistanceMap(
    world,
    canonicalSources,
    topology.controlledRegionIds,
  );
  const rebuilt: ControlledDistanceField = {
    nationId,
    territoryVersion: topology.territoryVersion,
    occupationVersion: topology.occupationVersion,
    sourceRegionIds: canonicalSources,
    distanceByRegionId: distances,
  };
  state.controlledDistanceByKey.set(key, rebuilt);
  state.statistics.controlledDistanceRebuilds += 1;
  increment(world, "aiGeography.controlledDistance.rebuilds");
  record(world, "aiGeography.controlledDistance", startedAt);
  return rebuilt;
}

export function getControlledFrontDistanceField(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): ControlledDistanceField | undefined {
  const front = world.landFronts.operationalSectorsById.get(frontId);
  const side = front ? getFrontSide(front, nationId) : undefined;
  return side
    ? getControlledDistanceField(world, nationId, side.borderRegionIds)
    : undefined;
}

export function getNearestControlledFrontDistanceField(
  world: WorldState,
  nationId: NationId,
): ControlledDistanceField {
  const sources = (
    world.landFronts.operationalSectorsByNationId.get(nationId) ?? []
  ).flatMap((front) => getFrontSide(front, nationId)?.borderRegionIds ?? []);
  return getControlledDistanceField(world, nationId, sources);
}

export function getFrontDistanceField(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): FrontDistanceField | undefined {
  const state = getAiGeographyState(world);
  synchronizeFrontDistanceVersion(world, state);
  state.statistics.frontDistanceRequests += 1;
  increment(world, "aiGeography.frontDistance.requests");
  const key = `${frontId}::${nationId}`;
  const cached = state.frontDistanceByKey.get(key);
  if (cached) {
    state.statistics.frontDistanceHits += 1;
    increment(world, "aiGeography.frontDistance.hits");
    return cached;
  }

  const front = world.landFronts.operationalSectorsById.get(frontId);
  const side = front ? getFrontSide(front, nationId) : undefined;
  if (!front || !side) return undefined;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const field: FrontDistanceField = {
    frontId,
    nationId,
    frontVersion: world.landFronts.version,
    sourceRegionIds: [...side.influenceRegionIds],
    distanceByRegionId: buildWarPassableDistanceMap(
      world,
      nationId,
      side.influenceRegionIds,
    ),
  };
  state.frontDistanceByKey.set(key, field);
  state.statistics.frontDistanceRebuilds += 1;
  increment(world, "aiGeography.frontDistance.rebuilds");
  record(world, "aiGeography.frontDistance", startedAt);
  return field;
}

/**
 * Front distance is consumed by several slow-tick systems. Preparing both
 * physical sides here keeps the geometry rebuild cost independent of whichever
 * consumer happens to ask first.
 */
export function prepareFrontDistanceFields(world: WorldState): void {
  for (const front of world.landFronts.operationalSectors) {
    getFrontDistanceField(world, front.id, front.sideA.nationId);
    getFrontDistanceField(world, front.id, front.sideB.nationId);
  }
}

export function getDistanceToFront(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
  regionId: MesoRegionId,
): number | undefined {
  return getFrontDistanceField(world, frontId, nationId)?.distanceByRegionId.get(
    regionId,
  );
}

export function nearestFront(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
): { frontId: FrontId; distance: number } | undefined {
  let nearest: { frontId: FrontId; distance: number } | undefined;
  for (const front of world.landFronts.operationalSectorsByNationId.get(nationId) ?? []) {
    const distance = getDistanceToFront(world, front.id, nationId, regionId);
    if (
      distance !== undefined &&
      (!nearest ||
        distance < nearest.distance ||
        (distance === nearest.distance && compareIds(front.id, nearest.frontId) < 0))
    ) {
      nearest = { frontId: front.id, distance };
    }
  }
  return nearest;
}

export function getDynamicSafetyLayer(world: WorldState): DynamicSafetyLayer {
  const state = getAiGeographyState(world);
  state.statistics.safetyRequests += 1;
  increment(world, "aiGeography.safety.requests");
  if (
    state.dynamicSafety?.generation === state.dynamicGeneration &&
    state.dynamicSafety.fastTick === world.time.fastTick
  ) {
    state.statistics.safetyHits += 1;
    increment(world, "aiGeography.safety.hits");
    return state.dynamicSafety;
  }
  const startedAt = world.instrumentation ? performance.now() : 0;
  const landUnitsByRegionId = new Map<
    MesoRegionId,
    Array<{ nationId: NationId; strength: number }>
  >();
  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    const list = landUnitsByRegionId.get(unit.regionId);
    const entry = {
      nationId: unit.nationId,
      strength: finiteNumber(getUnitCombatStrength(unit)),
    };
    if (list) list.push(entry);
    else landUnitsByRegionId.set(unit.regionId, [entry]);
  }
  const rebuilt: DynamicSafetyLayer = {
    generation: state.dynamicGeneration,
    fastTick: world.time.fastTick,
    warAdjacency: buildWarAdjacency(world.wars),
    battleRegionIds: new Set(world.battles.map((battle) => battle.mesoId)),
    landUnitsByRegionId,
    enemyRegionIdsByNationId: new Map(),
    enemyStrengthByRegionByNationId: new Map(),
  };
  state.dynamicSafety = rebuilt;
  state.statistics.safetyRebuilds += 1;
  increment(world, "aiGeography.safety.rebuilds");
  record(world, "aiGeography.dynamicSafety", startedAt);
  return rebuilt;
}

export function getSafeRegionState(world: WorldState): SafeRegionState {
  return getDynamicSafetyLayer(world);
}

export function invalidateDynamicSafety(world: WorldState): void {
  const state = getAiGeographyState(world);
  state.dynamicGeneration += 1;
  state.dynamicSafety = null;
}

export function getEnemyRegionIds(
  world: WorldState,
  nationId: NationId,
): ReadonlySet<MesoRegionId> {
  const layer = ensureEnemySafetyForNation(world, nationId);
  return (
    layer.enemyRegionIdsByNationId.get(nationId) ??
    EMPTY_REGION_SET
  );
}

export function getEnemyStrengthByRegion(
  world: WorldState,
  nationId: NationId,
): ReadonlyMap<MesoRegionId, number> {
  const layer = ensureEnemySafetyForNation(world, nationId);
  return (
    layer.enemyStrengthByRegionByNationId.get(nationId) ??
    EMPTY_DISTANCE_MAP
  );
}

export function isSafeControlledRegion(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  options: { excludeBattles?: boolean } = {},
): boolean {
  if (!getControlledRegions(world, nationId).has(regionId)) return false;
  const layer = ensureEnemySafetyForNation(world, nationId);
  if (layer.enemyRegionIdsByNationId.get(nationId)?.has(regionId)) return false;
  return !(
    options.excludeBattles &&
    layer.battleRegionIds.has(regionId)
  );
}

export function getAiGeographyStatistics(
  world: WorldState,
): Readonly<AiGeographyStatistics> {
  return { ...getAiGeographyState(world).statistics };
}

export function clearAiGeographyCache(world: WorldState): void {
  world.cache.aiGeography = createAiGeographyState();
}

function rebuildControlledTopologies(
  world: WorldState,
  state: AiGeographyCacheState,
): void {
  const ownerByMesoId = getOwnerByMesoId(world);
  const neighborsById = getNeighborsById(world);
  const controlledRegionIdsByNationId = new Map<NationId, Set<MesoRegionId>>(
    world.nations.map((nation) => [nation.id, new Set<MesoRegionId>()]),
  );
  for (const region of world.mesoRegions) {
    if (region.type === "sea") continue;
    const controller = effectiveController(
      region.id,
      ownerByMesoId,
      world.occupation.mesoById,
    );
    if (!controller) continue;
    let controlled = controlledRegionIdsByNationId.get(controller);
    if (!controlled) {
      controlled = new Set();
      controlledRegionIdsByNationId.set(controller, controlled);
    }
    controlled.add(region.id);
  }

  const topologyByNationId = new Map<NationId, ControlledTopology>();
  for (const [nationId, controlledRegionIds] of [
    ...controlledRegionIdsByNationId,
  ].sort(([a], [b]) => compareIds(a, b))) {
    const componentByRegionId = new Map<MesoRegionId, number>();
    const regionIdsByComponent = new Map<number, MesoRegionId[]>();
    let component = 0;
    for (const source of [...controlledRegionIds].sort(compareIds)) {
      if (componentByRegionId.has(source)) continue;
      const queue = [source];
      const componentRegions: MesoRegionId[] = [];
      componentByRegionId.set(source, component);
      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head];
        componentRegions.push(current);
        for (const neighborId of neighborsById.get(current) ?? []) {
          if (
            !controlledRegionIds.has(neighborId) ||
            componentByRegionId.has(neighborId)
          ) {
            continue;
          }
          componentByRegionId.set(neighborId, component);
          queue.push(neighborId);
        }
      }
      regionIdsByComponent.set(component, componentRegions);
      component += 1;
    }
    topologyByNationId.set(nationId, {
      nationId,
      territoryVersion: world.territoryVersion,
      occupationVersion: world.occupation.version,
      controlledRegionIds,
      componentByRegionId,
      regionIdsByComponent,
    });
  }

  state.topologyByNationId = topologyByNationId;
  state.topologyTerritoryVersion = world.territoryVersion;
  state.topologyOccupationVersion = world.occupation.version;
  state.controlledDistanceByKey.clear();
}

function createEmptyControlledTopology(
  world: WorldState,
  nationId: NationId,
): ControlledTopology {
  const topology: ControlledTopology = {
    nationId,
    territoryVersion: world.territoryVersion,
    occupationVersion: world.occupation.version,
    controlledRegionIds: new Set(),
    componentByRegionId: new Map(),
    regionIdsByComponent: new Map(),
  };
  getAiGeographyState(world).topologyByNationId.set(nationId, topology);
  return topology;
}

function buildControlledDistanceMap(
  world: WorldState,
  sources: readonly MesoRegionId[],
  controlledRegionIds: ReadonlySet<MesoRegionId>,
): Map<MesoRegionId, number> {
  const neighborsById = getNeighborsById(world);
  const distances = new Map<MesoRegionId, number>();
  const queue: MesoRegionId[] = [];
  for (const source of sources) {
    if (!controlledRegionIds.has(source) || distances.has(source)) continue;
    distances.set(source, 0);
    queue.push(source);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const neighborId of neighborsById.get(current) ?? []) {
      if (!controlledRegionIds.has(neighborId) || distances.has(neighborId)) {
        continue;
      }
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

function buildWarPassableDistanceMap(
  world: WorldState,
  nationId: NationId,
  sources: readonly MesoRegionId[],
): Map<MesoRegionId, number> {
  const neighborsById = getNeighborsById(world);
  const mesoById = getMesoById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const warAdjacency = buildWarAdjacency(world.wars);
  const distances = new Map<MesoRegionId, number>();
  const queue: MesoRegionId[] = [];
  for (const sourceId of sources) {
    const source = mesoById.get(sourceId);
    if (!source || source.type === "sea" || distances.has(sourceId)) continue;
    distances.set(sourceId, 0);
    queue.push(sourceId);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const neighborId of neighborsById.get(current) ?? []) {
      const neighbor = mesoById.get(neighborId);
      const owner = ownerByMesoId.get(neighborId);
      if (
        !neighbor ||
        neighbor.type === "sea" ||
        !owner ||
        (owner !== nationId && !isAtWar(nationId, owner, warAdjacency)) ||
        distances.has(neighborId)
      ) {
        continue;
      }
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

function ensureEnemySafetyForNation(
  world: WorldState,
  nationId: NationId,
): DynamicSafetyLayer {
  const layer = getDynamicSafetyLayer(world);
  if (layer.enemyRegionIdsByNationId.has(nationId)) return layer;
  const regionIds = new Set<MesoRegionId>();
  const strengthByRegion = new Map<MesoRegionId, number>();
  for (const [regionId, units] of layer.landUnitsByRegionId) {
    for (const unit of units) {
      if (!isAtWar(nationId, unit.nationId, layer.warAdjacency)) continue;
      regionIds.add(regionId);
      strengthByRegion.set(
        regionId,
        (strengthByRegion.get(regionId) ?? 0) + unit.strength,
      );
    }
  }
  layer.enemyRegionIdsByNationId.set(nationId, regionIds);
  layer.enemyStrengthByRegionByNationId.set(nationId, strengthByRegion);
  return layer;
}

function synchronizeFrontDistanceVersion(
  world: WorldState,
  state: AiGeographyCacheState,
): void {
  if (state.frontDistanceVersion === world.landFronts.version) return;
  state.frontDistanceByKey.clear();
  state.frontDistanceVersion = world.landFronts.version;
}

function getAiGeographyState(world: WorldState): AiGeographyCacheState {
  world.cache.aiGeography ??= createAiGeographyState();
  return world.cache.aiGeography;
}

function createAiGeographyState(): AiGeographyCacheState {
  return {
    topologyTerritoryVersion: -1,
    topologyOccupationVersion: -1,
    topologyByNationId: new Map(),
    controlledDistanceByKey: new Map(),
    frontDistanceVersion: -1,
    frontDistanceByKey: new Map(),
    dynamicGeneration: 0,
    dynamicSafety: null,
    statistics: {
      topologyRequests: 0,
      topologyHits: 0,
      topologyRebuilds: 0,
      controlledDistanceRequests: 0,
      controlledDistanceHits: 0,
      controlledDistanceRebuilds: 0,
      frontDistanceRequests: 0,
      frontDistanceHits: 0,
      frontDistanceRebuilds: 0,
      safetyRequests: 0,
      safetyHits: 0,
      safetyRebuilds: 0,
    },
  };
}

function getFrontSide(
  front: OperationalSector,
  nationId: NationId,
) {
  if (front.sideA.nationId === nationId) return front.sideA;
  if (front.sideB.nationId === nationId) return front.sideB;
  return undefined;
}

function effectiveController(
  regionId: MesoRegionId,
  ownerByMesoId: ReadonlyMap<MesoRegionId, NationId>,
  occupationByMesoId: ReadonlyMap<MesoRegionId, NationId>,
): NationId | undefined {
  return occupationByMesoId.get(regionId) ?? ownerByMesoId.get(regionId);
}

function increment(world: WorldState, name: string): void {
  const instrumentation = world.instrumentation as
    | (typeof world.instrumentation & {
        incrementCounter(name: string, amount?: number): void;
      })
    | undefined;
  instrumentation?.incrementCounter(name);
}

function record(world: WorldState, name: string, startedAt: number): void {
  const instrumentation = world.instrumentation as
    | (typeof world.instrumentation & {
        recordDuration(name: string, durationMs: number): void;
      })
    | undefined;
  instrumentation?.recordDuration(name, performance.now() - startedAt);
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const EMPTY_REGION_SET: ReadonlySet<MesoRegionId> = new Set();
const EMPTY_DISTANCE_MAP: ReadonlyMap<MesoRegionId, number> = new Map();
