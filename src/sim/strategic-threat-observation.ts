import type { NationId } from "../worldgen/nation";
import { getControlledTopology } from "./ai-geography";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";
import {
  getAdjacentNationPairs,
  getCityTargetsByNation,
  getMesoById,
  getNeighborsById,
  getPortTargetsByNation,
} from "./world-cache";

const HISTORY_CAPACITY = 8;

export interface StrategicPowerObservation {
  score: number;
  effectiveCombatStrength: number;
  landStrength: number;
  navalCombatStrength: number;
  combatShips: number;
  transports: number;
  productionCapability: number;
  manpower: number;
  equipment: number;
}

export interface StrategicMomentumObservation {
  score: number;
  territoryGrowth: number;
  cityGrowth: number;
  powerGrowth: number;
  strategicSuccessGrowth: number;
  expansionRate: number;
  trend: "rising" | "stable" | "falling";
}

export interface StrategicIntentEvidence {
  score: number;
  warsInitiated: number;
  successfulOperations: number;
  successfulSupplyCutoffs: number;
  successfulAmphibiousLandings: number;
  capturedCapitals: number;
  recentStrategicProgress: number;
}

export interface StrategicVulnerabilityObservation {
  score: number;
  capitalExposure: number;
  maritimeDependence: number;
  weakFrontier: number;
  isolatedRegions: number;
}

export interface StrategicNationObservation {
  nationId: NationId;
  power: StrategicPowerObservation;
  momentum: StrategicMomentumObservation;
  intent: StrategicIntentEvidence;
  vulnerability: StrategicVulnerabilityObservation;
  threatScore: number;
  threatRank: number;
  territoryCount: number;
  cityCount: number;
  existingWars: number;
  maritimeCapability: number;
  strategicProgress: number;
  evaluatedAtTick: number;
}

/** Sparse, cached-edge-only exposure. Missing pairs have no observed reach evidence. */
export interface StrategicExposureObservation {
  observerNationId: NationId;
  threatNationId: NationId;
  score: number;
  landAdjacent: boolean;
  atWar: boolean;
  sharedSeaComponent: boolean;
  capitalProximity: number | null;
  supplyExposure: number;
}

interface StrategicHistoryBuffer {
  length: number;
  nextIndex: number;
  territory: Float64Array;
  cities: Float64Array;
  power: Float64Array;
  strategicSuccess: Float64Array;
}

interface MutableNationFacts {
  nationId: NationId;
  power: StrategicPowerObservation;
  territoryCount: number;
  cityCount: number;
  existingWars: number;
  strategicProgress: number;
  intent: StrategicIntentEvidence;
  vulnerability: StrategicVulnerabilityObservation;
}

export interface StrategicThreatObservationState {
  observations: StrategicNationObservation[];
  observationByNationId: Map<NationId, StrategicNationObservation>;
  exposures: StrategicExposureObservation[];
  exposureByPair: Map<string, StrategicExposureObservation>;
  historyByNationId: Map<NationId, StrategicHistoryBuffer>;
  activeWarKeys: Set<string>;
  warsInitiatedByNationId: Map<NationId, number>;
  version: number;
  evaluationCount: number;
  nationEvaluationCount: number;
  historyUpdateCount: number;
  topThreatChangeCount: number;
  rankingChangeCount: number;
  evaluationCpuMs: number;
  averagePower: number;
  averageMomentum: number;
  estimatedMemoryBytes: number;
  topThreatNationId: NationId | null;
}

export function createStrategicThreatObservationState(): StrategicThreatObservationState {
  return {
    observations: [],
    observationByNationId: new Map(),
    exposures: [],
    exposureByPair: new Map(),
    historyByNationId: new Map(),
    activeWarKeys: new Set(),
    warsInitiatedByNationId: new Map(),
    version: 0,
    evaluationCount: 0,
    nationEvaluationCount: 0,
    historyUpdateCount: 0,
    topThreatChangeCount: 0,
    rankingChangeCount: 0,
    evaluationCpuMs: 0,
    averagePower: 0,
    averageMomentum: 0,
    estimatedMemoryBytes: 0,
    topThreatNationId: null,
  };
}

export function getStrategicNationObservation(
  world: WorldState,
  nationId: NationId,
): StrategicNationObservation | undefined {
  return world.strategicThreatObservation.observationByNationId.get(nationId);
}

export function getStrategicExposureObservation(
  world: WorldState,
  observerNationId: NationId,
  threatNationId: NationId,
): StrategicExposureObservation | undefined {
  return world.strategicThreatObservation.exposureByPair.get(
    pairKey(observerNationId, threatNationId),
  );
}

/**
 * Produces the completed slow-tick snapshot. Strategic consumers intentionally
 * read it on the following tick so this pass remains shared and single-shot.
 */
export function updateStrategicThreatObservation(world: WorldState): void {
  const state = world.strategicThreatObservation;
  const startedAt = world.instrumentation ? performance.now() : 0;
  observeNewWars(world);

  const factsByNationId = collectNationFacts(world);
  normalizePowerScores(factsByNationId);
  const previousRanks = new Map(
    state.observations.map((observation) => [observation.nationId, observation.threatRank]),
  );
  const observations: StrategicNationObservation[] = [];
  for (const nation of world.nations) {
    const facts = factsByNationId.get(nation.id)!;
    const history = getOrCreateHistory(state, nation.id);
    const momentum = calculateMomentum(history, facts);
    const threatScore = clamp(
      facts.power.score * 0.65 + Math.max(0, momentum.score) * 0.15 +
        facts.intent.score * 0.2,
      0,
      100,
    );
    observations.push({
      nationId: nation.id,
      power: facts.power,
      momentum,
      intent: facts.intent,
      vulnerability: facts.vulnerability,
      threatScore,
      threatRank: 0,
      territoryCount: facts.territoryCount,
      cityCount: facts.cityCount,
      existingWars: facts.existingWars,
      maritimeCapability: facts.power.combatShips + facts.power.transports,
      strategicProgress: facts.strategicProgress,
      evaluatedAtTick: world.time.fastTick,
    });
    writeHistory(history, facts);
    state.historyUpdateCount += 1;
    world.instrumentation?.incrementCounter("strategicThreat.historyUpdates");
  }

  observations.sort((a, b) =>
    b.threatScore - a.threatScore || compareIds(a.nationId, b.nationId)
  );
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    observation.threatRank = index + 1;
    const previousRank = previousRanks.get(observation.nationId);
    if (previousRank !== undefined && previousRank !== observation.threatRank) {
      state.rankingChangeCount += 1;
      world.instrumentation?.incrementCounter("strategicThreat.rankingChanges");
    }
  }
  const nextTop = observations[0]?.nationId ?? null;
  if (state.topThreatNationId !== null && nextTop !== state.topThreatNationId) {
    state.topThreatChangeCount += 1;
    world.instrumentation?.incrementCounter("strategicThreat.topThreatChanges");
  }

  const exposures = collectSparseExposures(world, factsByNationId);
  state.observations = observations;
  state.observationByNationId = new Map(
    observations.map((observation) => [observation.nationId, observation]),
  );
  state.exposures = exposures;
  state.exposureByPair = new Map(exposures.map((exposure) => [
    pairKey(exposure.observerNationId, exposure.threatNationId),
    exposure,
  ]));
  state.topThreatNationId = nextTop;
  state.averagePower = average(observations, (item) => item.power.score);
  state.averageMomentum = average(observations, (item) => item.momentum.score);
  state.evaluationCount += 1;
  state.nationEvaluationCount += observations.length;
  state.estimatedMemoryBytes = estimateMemoryBytes(state);
  state.version += 1;
  world.instrumentation?.incrementCounter(
    "strategicThreat.nationEvaluations",
    observations.length,
  );
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    state.evaluationCpuMs += elapsed;
    world.instrumentation.recordDuration("strategicThreat.evaluation", elapsed);
  }
}

function collectNationFacts(world: WorldState): Map<NationId, MutableNationFacts> {
  const factsByNationId = new Map<NationId, MutableNationFacts>();
  const citiesByNation = getCityTargetsByNation(world);
  const frontierByNation = new Map<NationId, { segments: number; weak: number }>();
  for (const coverage of world.frontlineCoverage.coverages) {
    const current = frontierByNation.get(coverage.nationId) ?? { segments: 0, weak: 0 };
    current.segments += coverage.positions.length;
    current.weak += coverage.weakSegments + coverage.gapSegments;
    frontierByNation.set(coverage.nationId, current);
  }
  const warsByNation = new Map<NationId, number>();
  for (const war of world.wars) {
    warsByNation.set(war.nationAId, (warsByNation.get(war.nationAId) ?? 0) + 1);
    warsByNation.set(war.nationBId, (warsByNation.get(war.nationBId) ?? 0) + 1);
  }
  for (const nation of world.nations) {
    const supply = world.supplyAssessment.assessmentByNationId.get(nation.id);
    const capital = world.capitalDefense.assessmentsByNationId.get(nation.id);
    const frontier = frontierByNation.get(nation.id);
    const frontierSegments = frontier?.segments ?? 0;
    const weakSegments = frontier?.weak ?? 0;
    const totalComponents = supply?.components.length ?? 0;
    const maritimeComponents = supply?.components.filter((component) =>
      component.reason === "maritime-connected"
    ).length ?? 0;
    const isolatedRegions = supply?.components.reduce(
      (sum, component) => sum + (component.isolated ? component.regionIds.length : 0),
      0,
    ) ?? 0;
    factsByNationId.set(nation.id, {
      nationId: nation.id,
      power: {
        score: 0,
        effectiveCombatStrength: 0,
        landStrength: 0,
        navalCombatStrength: 0,
        combatShips: 0,
        transports: 0,
        productionCapability: Math.max(0,
          nation.resourceFlow.income.manpower + nation.resourceFlow.income.weapons +
          nation.resourceFlow.income.steel,
        ),
        manpower: Math.max(0, nation.resources.manpower),
        equipment: Math.max(0, nation.resources.weapons),
      },
      territoryCount: getControlledTopology(world, nation.id).controlledRegionIds.size,
      cityCount: citiesByNation.get(nation.id)?.length ?? 0,
      existingWars: warsByNation.get(nation.id) ?? 0,
      strategicProgress: 0,
      intent: {
        score: 0,
        warsInitiated: world.strategicThreatObservation.warsInitiatedByNationId.get(nation.id) ?? 0,
        successfulOperations: 0,
        successfulSupplyCutoffs: 0,
        successfulAmphibiousLandings: 0,
        capturedCapitals: 0,
        recentStrategicProgress: 0,
      },
      vulnerability: {
        score: 0,
        capitalExposure: capital?.threatLevel === "critical" ? 1 :
          capital?.threatLevel === "threatened" ? 0.5 : 0,
        maritimeDependence: totalComponents > 0 ? maritimeComponents / totalComponents : 0,
        weakFrontier: frontierSegments > 0 ? weakSegments / frontierSegments : 0,
        isolatedRegions,
      },
    });
  }

  for (const unit of world.units) {
    const facts = factsByNationId.get(unit.nationId);
    if (!facts || unit.manpower <= 0 || unit.org <= 0) continue;
    const strength = getUnitCombatStrength(unit);
    facts.power.effectiveCombatStrength += strength;
    facts.power.manpower += Math.max(0, unit.manpower);
    for (const slot of unit.equipment) facts.power.equipment += Math.max(0, slot.fill);
    if (unit.domain === "land") facts.power.landStrength += strength;
    else if (unit.type === "CombatShip") {
      facts.power.navalCombatStrength += strength;
      facts.power.combatShips += 1;
    } else if (unit.type === "TransportShip") facts.power.transports += 1;
  }

  const operations = [...world.offensiveOperations.operations, ...world.offensiveOperations.history];
  for (const operation of operations) {
    const facts = factsByNationId.get(operation.nationId);
    if (!facts || operation.outcome !== "success") continue;
    facts.intent.successfulOperations += 1;
    if (operation.supplyCutoffConfirmation &&
      (operation.supplyCutoffConfirmation.state === "cut" ||
        operation.supplyCutoffConfirmation.state === "sustained")) {
      facts.intent.successfulSupplyCutoffs += 1;
    }
    for (const regionId of operation.capturedRegionIds) {
      if (getMesoById(world).get(regionId)?.building === "capital") {
        facts.intent.capturedCapitals += 1;
      }
    }
  }
  for (const operation of world.amphibiousOperations.operations) {
    if (operation.phase === "landed") {
      const facts = factsByNationId.get(operation.nationId);
      if (facts) facts.intent.successfulAmphibiousLandings += 1;
    }
  }
  for (const progress of world.strategicProgress.assessments) {
    const facts = factsByNationId.get(progress.nationId);
    if (!facts) continue;
    facts.strategicProgress = Math.max(facts.strategicProgress, progress.score);
    if (progress.resetsPressure) facts.intent.recentStrategicProgress += 1;
  }
  for (const facts of factsByNationId.values()) {
    const intentUnits = facts.intent.warsInitiated * 2 +
      facts.intent.successfulOperations * 1.5 +
      facts.intent.successfulSupplyCutoffs * 2 +
      facts.intent.successfulAmphibiousLandings * 2 +
      facts.intent.capturedCapitals * 3 +
      facts.intent.recentStrategicProgress;
    facts.intent.score = clamp(intentUnits * 5, 0, 100);
    facts.vulnerability.score = clamp(
      facts.vulnerability.capitalExposure * 35 +
        facts.vulnerability.maritimeDependence * 20 +
        facts.vulnerability.weakFrontier * 30 +
        Math.min(1, facts.vulnerability.isolatedRegions / Math.max(1, facts.territoryCount)) * 15,
      0,
      100,
    );
  }
  return factsByNationId;
}

function normalizePowerScores(factsByNationId: Map<NationId, MutableNationFacts>): void {
  let maxCombat = 0;
  let maxNaval = 0;
  let maxTransport = 0;
  let maxProduction = 0;
  let maxManpower = 0;
  let maxEquipment = 0;
  for (const { power } of factsByNationId.values()) {
    maxCombat = Math.max(maxCombat, power.effectiveCombatStrength);
    maxNaval = Math.max(maxNaval, power.navalCombatStrength);
    maxTransport = Math.max(maxTransport, power.transports);
    maxProduction = Math.max(maxProduction, power.productionCapability);
    maxManpower = Math.max(maxManpower, power.manpower);
    maxEquipment = Math.max(maxEquipment, power.equipment);
  }
  for (const { power } of factsByNationId.values()) {
    power.score = normalize(power.effectiveCombatStrength, maxCombat) * 50 +
      normalize(power.navalCombatStrength, maxNaval) * 10 +
      normalize(power.transports, maxTransport) * 10 +
      normalize(power.productionCapability, maxProduction) * 10 +
      normalize(power.manpower, maxManpower) * 10 +
      normalize(power.equipment, maxEquipment) * 10;
  }
}

function calculateMomentum(
  history: StrategicHistoryBuffer,
  facts: MutableNationFacts,
): StrategicMomentumObservation {
  if (history.length === 0) {
    return { score: 0, territoryGrowth: 0, cityGrowth: 0, powerGrowth: 0,
      strategicSuccessGrowth: 0, expansionRate: 0, trend: "stable" };
  }
  const oldestIndex = (history.nextIndex - history.length + HISTORY_CAPACITY) % HISTORY_CAPACITY;
  const territoryGrowth = facts.territoryCount - history.territory[oldestIndex];
  const cityGrowth = facts.cityCount - history.cities[oldestIndex];
  const powerGrowth = percentChange(facts.power.score, history.power[oldestIndex]);
  const currentSuccess = strategicSuccessTotal(facts.intent);
  const strategicSuccessGrowth = currentSuccess - history.strategicSuccess[oldestIndex];
  const intervals = Math.max(1, history.length);
  const expansionRate = territoryGrowth / intervals;
  const score = clamp(
    territoryGrowth * 5 + cityGrowth * 10 + powerGrowth * 0.35 +
      strategicSuccessGrowth * 8,
    -100,
    100,
  );
  return {
    score,
    territoryGrowth,
    cityGrowth,
    powerGrowth,
    strategicSuccessGrowth,
    expansionRate,
    trend: score > 5 ? "rising" : score < -5 ? "falling" : "stable",
  };
}

function collectSparseExposures(
  world: WorldState,
  factsByNationId: Map<NationId, MutableNationFacts>,
): StrategicExposureObservation[] {
  const candidates = new Map<string, { a: NationId; b: NationId; landAdjacent: boolean; atWar: boolean }>();
  for (const [a, b] of getAdjacentNationPairs(world)) {
    candidates.set(undirectedPairKey(a, b), { a, b, landAdjacent: true, atWar: false });
  }
  for (const war of world.wars) {
    const key = undirectedPairKey(war.nationAId, war.nationBId);
    const existing = candidates.get(key);
    if (existing) existing.atWar = true;
    else candidates.set(key, { a: war.nationAId, b: war.nationBId, landAdjacent: false, atWar: true });
  }
  const seaComponentsByNation = collectSeaComponentsByNation(world);
  const nationsBySeaComponent = new Map<number, NationId[]>();
  for (const [nationId, components] of seaComponentsByNation) {
    for (const component of components) {
      const nations = nationsBySeaComponent.get(component);
      if (nations) nations.push(nationId);
      else nationsBySeaComponent.set(component, [nationId]);
    }
  }
  // Add only port-connected nation pairs. This is a bounded component join,
  // not a topology scan, and makes peaceful overseas exposure observable.
  for (const nations of nationsBySeaComponent.values()) {
    nations.sort(compareIds);
    for (let i = 0; i < nations.length; i += 1) {
      for (let j = i + 1; j < nations.length; j += 1) {
        const a = nations[i];
        const b = nations[j];
        const key = undirectedPairKey(a, b);
        if (!candidates.has(key)) {
          candidates.set(key, { a, b, landAdjacent: false, atWar: false });
        }
      }
    }
  }
  const exposures: StrategicExposureObservation[] = [];
  for (const candidate of candidates.values()) {
    exposures.push(buildExposure(world, factsByNationId, seaComponentsByNation,
      candidate.a, candidate.b, candidate.landAdjacent, candidate.atWar));
    exposures.push(buildExposure(world, factsByNationId, seaComponentsByNation,
      candidate.b, candidate.a, candidate.landAdjacent, candidate.atWar));
  }
  return exposures.sort((a, b) =>
    compareIds(a.observerNationId, b.observerNationId) ||
    compareIds(a.threatNationId, b.threatNationId)
  );
}

function buildExposure(
  world: WorldState,
  factsByNationId: Map<NationId, MutableNationFacts>,
  seaComponentsByNation: Map<NationId, Set<number>>,
  observerNationId: NationId,
  threatNationId: NationId,
  landAdjacent: boolean,
  atWar: boolean,
): StrategicExposureObservation {
  const sharedSeaComponent = setsIntersect(
    seaComponentsByNation.get(observerNationId),
    seaComponentsByNation.get(threatNationId),
  );
  const capital = world.capitalDefense.assessmentsByNationId.get(observerNationId);
  const capitalProximity = atWar ? capital?.nearestFrontDistance ?? null : null;
  const vulnerability = factsByNationId.get(observerNationId)?.vulnerability;
  const supplyExposure = clamp(
    (vulnerability?.maritimeDependence ?? 0) * 0.6 +
      Math.min(1, (vulnerability?.isolatedRegions ?? 0) / 5) * 0.4,
    0,
    1,
  );
  return {
    observerNationId,
    threatNationId,
    landAdjacent,
    atWar,
    sharedSeaComponent,
    capitalProximity,
    supplyExposure,
    score: clamp(
      (landAdjacent ? 40 : 0) + (atWar ? 25 : 0) +
        (sharedSeaComponent ? 15 : 0) + supplyExposure * 10 +
        (capitalProximity !== null ? Math.max(0, 10 - capitalProximity * 2) : 0),
      0,
      100,
    ),
  };
}

function collectSeaComponentsByNation(world: WorldState): Map<NationId, Set<number>> {
  const result = new Map<NationId, Set<number>>();
  const portsByNation = getPortTargetsByNation(world);
  const neighborsById = getNeighborsById(world);
  const mesoById = getMesoById(world);
  const componentByRegionId = world.supplyAssessment.maritimeConnectivity.seaComponentByRegionId;
  for (const [nationId, portIds] of portsByNation) {
    const components = new Set<number>();
    for (const portId of portIds) {
      for (const neighborId of neighborsById.get(portId) ?? []) {
        if (mesoById.get(neighborId)?.type !== "sea") continue;
        const component = componentByRegionId.get(neighborId);
        if (component !== undefined) components.add(component);
      }
    }
    result.set(nationId, components);
  }
  return result;
}

function observeNewWars(world: WorldState): void {
  const state = world.strategicThreatObservation;
  const nextActive = new Set<string>();
  for (const war of world.wars) {
    const key = `${war.startedAtFastTick}:${undirectedPairKey(war.nationAId, war.nationBId)}`;
    nextActive.add(key);
    if (state.activeWarKeys.has(key)) continue;
    state.warsInitiatedByNationId.set(
      war.aggressorId,
      (state.warsInitiatedByNationId.get(war.aggressorId) ?? 0) + 1,
    );
  }
  state.activeWarKeys = nextActive;
}

function getOrCreateHistory(
  state: StrategicThreatObservationState,
  nationId: NationId,
): StrategicHistoryBuffer {
  let history = state.historyByNationId.get(nationId);
  if (!history) {
    history = { length: 0, nextIndex: 0, territory: new Float64Array(HISTORY_CAPACITY),
      cities: new Float64Array(HISTORY_CAPACITY), power: new Float64Array(HISTORY_CAPACITY),
      strategicSuccess: new Float64Array(HISTORY_CAPACITY) };
    state.historyByNationId.set(nationId, history);
  }
  return history;
}

function writeHistory(history: StrategicHistoryBuffer, facts: MutableNationFacts): void {
  const index = history.nextIndex;
  history.territory[index] = facts.territoryCount;
  history.cities[index] = facts.cityCount;
  history.power[index] = facts.power.score;
  history.strategicSuccess[index] = strategicSuccessTotal(facts.intent);
  history.nextIndex = (index + 1) % HISTORY_CAPACITY;
  history.length = Math.min(HISTORY_CAPACITY, history.length + 1);
}

function strategicSuccessTotal(intent: StrategicIntentEvidence): number {
  return intent.successfulOperations + intent.successfulSupplyCutoffs +
    intent.successfulAmphibiousLandings + intent.capturedCapitals +
    intent.recentStrategicProgress;
}

function estimateMemoryBytes(state: StrategicThreatObservationState): number {
  const historyBytes = state.historyByNationId.size * HISTORY_CAPACITY * 4 * Float64Array.BYTES_PER_ELEMENT;
  const observationBytes = state.observations.length * 320;
  const exposureBytes = state.exposures.length * 96;
  const mapBytes = (state.observationByNationId.size + state.exposureByPair.size) * 48;
  return historyBytes + observationBytes + exposureBytes + mapBytes;
}

function setsIntersect(a: ReadonlySet<number> | undefined, b: ReadonlySet<number> | undefined): boolean {
  if (!a || !b || a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) return true;
  return false;
}

function normalize(value: number, maximum: number): number {
  return maximum > 0 ? clamp(value / maximum, 0, 1) : 0;
}

function percentChange(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return (current - previous) / previous * 100;
}

function average<T>(items: readonly T[], read: (item: T) => number): number {
  if (items.length === 0) return 0;
  let total = 0;
  for (const item of items) total += read(item);
  return total / items.length;
}

function pairKey(observerNationId: NationId, threatNationId: NationId): string {
  return `${observerNationId}::${threatNationId}`;
}

function undirectedPairKey(a: NationId, b: NationId): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
