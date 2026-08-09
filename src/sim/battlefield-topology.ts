import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { WORLD_BALANCE } from "../data/balance";
import { getControlledTopology, getEnemyStrengthByRegion } from "./ai-geography";
import { getFrontlineCoverage } from "./frontline-coverage";
import { getFrontSide, getOpposingFrontSide, type FrontId } from "./land-fronts";
import { isNationActive } from "./nation-active";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById } from "./world-cache";

export type BattlefieldComponentId = string & { __brand: "BattlefieldComponentId" };

export type CollapseTopologyReason =
  | "enemy-front-fragmented"
  | "low-defender-strength"
  | "continuous-gap"
  | "isolated-component"
  | "single-exit-component"
  | "rear-access-open"
  | "front-contact-lost";

export interface EnemyTopologyComponent {
  id: BattlefieldComponentId;
  enemyNationId: NationId;
  regionIds: MesoRegionId[];
  regionCount: number;
  frontlineContactCount: number;
  friendlyAttackContactCount: number;
  enemyStrength: number;
  cities: number;
  hasCapital: boolean;
  exitCount: number;
  connectsToStrategicRear: boolean;
}

export interface BattlefieldArticulationRegion {
  regionId: MesoRegionId;
  componentId: BattlefieldComponentId;
  resultingComponentSizes: number[];
  affectedRegionCount: number;
  enemyStrengthAffected: number;
  citiesAffected: number;
  capitalAffected: boolean;
  frontlineContactsAffected: number;
}

export interface EscapeCorridor {
  regionId: MesoRegionId;
  componentId: BattlefieldComponentId;
  exitCount: 1;
  affectedRegionCount: number;
  enemyStrengthAffected: number;
  citiesAffected: number;
  frontlineContactsAffected: number;
}

export interface CollapseOpportunity {
  attackerNationId: NationId;
  enemyNationId: NationId;
  sectorId: FrontId;
  componentId: BattlefieldComponentId;
  targetRegionId: MesoRegionId;
  score: number;
  reasonFlags: CollapseTopologyReason[];
  enemyStrength: number;
  defenderStrength: number;
  regionCount: number;
  exitCount: number;
  detectedAtTick: number;
}

export interface BattlefieldTopologyAssessment {
  attackerNationId: NationId;
  enemyNationId: NationId;
  enemyComponents: EnemyTopologyComponent[];
  articulationRegions: BattlefieldArticulationRegion[];
  escapeCorridors: EscapeCorridor[];
  collapseComponents: EnemyTopologyComponent[];
  pocketCandidates: EnemyTopologyComponent[];
  collapseOpportunities: CollapseOpportunity[];
  topologyVersion: number;
  evaluatedAtTick: number;
}

interface Range { start: number; end: number }
interface StructuralArticulation {
  regionId: MesoRegionId;
  resultingComponentSizes: number[];
  affectedRanges: Range[];
}
interface StructuralComponent {
  id: BattlefieldComponentId;
  enemyNationId: NationId;
  regionIds: MesoRegionId[];
  dfsOrder: MesoRegionId[];
  connectsToStrategicRear: boolean;
  articulations: StructuralArticulation[];
}
interface StructuralAssessment {
  attackerNationId: NationId;
  enemyNationId: NationId;
  components: StructuralComponent[];
}

export interface BattlefieldTopologyState {
  assessments: BattlefieldTopologyAssessment[];
  assessmentsByPair: Map<string, BattlefieldTopologyAssessment>;
  structuralByPair: Map<string, StructuralAssessment>;
  territoryVersion: number;
  occupationVersion: number;
  landFrontVersion: number;
  version: number;
  rebuildCount: number;
  cacheHitCount: number;
  enemyComponentCount: number;
  articulationPointCount: number;
  zeroExitComponentCount: number;
  oneExitComponentCount: number;
  collapseOpportunityCount: number;
  ignoredCollapseOpportunityCount: number;
  ignoredCollapseOpportunityKeys: Set<string>;
  componentFragmentationEvents: number;
  warsEndingAfterCollapse: number;
  previousComponentCountByPair: Map<string, number>;
  activePairKeys: Set<string>;
  lastCollapseTickByPair: Map<string, number>;
}

const WAR_END_COLLAPSE_WINDOW = 100;

export function createBattlefieldTopologyState(): BattlefieldTopologyState {
  return {
    assessments: [], assessmentsByPair: new Map(), structuralByPair: new Map(),
    territoryVersion: -1, occupationVersion: -1, landFrontVersion: -1, version: 0,
    rebuildCount: 0, cacheHitCount: 0, enemyComponentCount: 0,
    articulationPointCount: 0, zeroExitComponentCount: 0, oneExitComponentCount: 0,
    collapseOpportunityCount: 0, ignoredCollapseOpportunityCount: 0,
    ignoredCollapseOpportunityKeys: new Set(),
    componentFragmentationEvents: 0, warsEndingAfterCollapse: 0,
    previousComponentCountByPair: new Map(), activePairKeys: new Set(),
    lastCollapseTickByPair: new Map(),
  };
}

export function getBattlefieldTopologyAssessment(
  world: WorldState,
  attackerNationId: NationId,
  enemyNationId: NationId,
): BattlefieldTopologyAssessment | undefined {
  return world.battlefieldTopology.assessmentsByPair.get(pairKey(attackerNationId, enemyNationId));
}

export function getCollapseOpportunities(
  world: WorldState,
  attackerNationId?: NationId,
): readonly CollapseOpportunity[] {
  return world.battlefieldTopology.assessments.flatMap((assessment) =>
    attackerNationId && assessment.attackerNationId !== attackerNationId
      ? []
      : assessment.collapseOpportunities,
  );
}

export function updateBattlefieldTopology(world: WorldState): void {
  const state = world.battlefieldTopology;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const structuralChanged = state.territoryVersion !== world.territoryVersion ||
    state.occupationVersion !== world.occupation.version ||
    state.landFrontVersion !== world.landFronts.version;
  if (structuralChanged) {
    const structuralStartedAt = world.instrumentation ? performance.now() : 0;
    rebuildStructure(world, state);
    world.instrumentation?.recordDuration(
      "battlefieldTopology.structural",
      performance.now() - structuralStartedAt,
    );
    state.rebuildCount += 1;
    world.instrumentation?.incrementCounter("battlefieldTopology.rebuilds");
  } else {
    state.cacheHitCount += 1;
    world.instrumentation?.incrementCounter("battlefieldTopology.cacheHits");
  }
  const previousOpportunities = new Map(
    state.assessments.flatMap((assessment) => assessment.collapseOpportunities.map(
      (opportunity) => [opportunityKey(opportunity), opportunity] as const,
    )),
  );
  const dynamicStartedAt = world.instrumentation ? performance.now() : 0;
  state.assessments = [...state.structuralByPair.values()]
    .map((structure) => materializeAssessment(world, structure, state.version + 1))
    .sort(compareAssessments);
  state.assessmentsByPair = new Map(state.assessments.map((assessment) => [
    pairKey(assessment.attackerNationId, assessment.enemyNationId), assessment,
  ]));
  world.instrumentation?.recordDuration(
    "battlefieldTopology.dynamic",
    performance.now() - dynamicStartedAt,
  );
  if (structuralChanged) {
    const components = state.assessments.flatMap((assessment) => assessment.enemyComponents);
    const articulations = state.assessments.flatMap((assessment) => assessment.articulationRegions);
    const zeroExit = components.filter((component) => component.exitCount === 0).length;
    const oneExit = state.assessments.reduce((sum, assessment) => sum + assessment.escapeCorridors.length, 0);
    state.enemyComponentCount += components.length;
    state.articulationPointCount += articulations.length;
    state.zeroExitComponentCount += zeroExit;
    state.oneExitComponentCount += oneExit;
    world.instrumentation?.incrementCounter("battlefieldTopology.enemyComponents", components.length);
    world.instrumentation?.incrementCounter("battlefieldTopology.articulationPoints", articulations.length);
    world.instrumentation?.incrementCounter("battlefieldTopology.zeroExitComponents", zeroExit);
    world.instrumentation?.incrementCounter("battlefieldTopology.oneExitComponents", oneExit);
  }
  for (const assessment of state.assessments) {
    for (const opportunity of assessment.collapseOpportunities) {
      const previous = previousOpportunities.get(opportunityKey(opportunity));
      if (previous) opportunity.detectedAtTick = previous.detectedAtTick;
      state.lastCollapseTickByPair.set(
        pairKey(opportunity.attackerNationId, opportunity.enemyNationId),
        world.time.fastTick,
      );
      if (!previous) {
        state.collapseOpportunityCount += 1;
        world.instrumentation?.incrementCounter("battlefieldTopology.collapseOpportunities");
      }
    }
  }
  state.version += 1;
  world.instrumentation?.recordDuration(
    "battlefieldTopology.evaluation",
    performance.now() - startedAt,
  );
}

function rebuildStructure(world: WorldState, state: BattlefieldTopologyState): void {
  const previous = state.structuralByPair;
  const next = new Map<string, StructuralAssessment>();
  const activePairs = new Set<string>();
  const componentsByEnemy = new Map<NationId, StructuralComponent[]>();
  const orderedPairs = world.wars.flatMap((war) => [
    [war.nationAId, war.nationBId] as const,
    [war.nationBId, war.nationAId] as const,
  ]).filter(([attacker, enemy]) =>
    world.nations.some((nation) => nation.id === attacker && isNationActive(nation)) &&
    world.nations.some((nation) => nation.id === enemy && isNationActive(nation)),
  ).sort(([a1, e1], [a2, e2]) => compareIds(a1, a2) || compareIds(e1, e2));
  for (const [attackerNationId, enemyNationId] of orderedPairs) {
    const key = pairKey(attackerNationId, enemyNationId);
    activePairs.add(key);
    let components = componentsByEnemy.get(enemyNationId);
    if (!components) {
      const topology = getControlledTopology(world, enemyNationId);
      const previousComponents = [...previous.values()].find(
        (assessment) => assessment.enemyNationId === enemyNationId,
      )?.components ?? [];
      const usedPreviousIds = new Set<BattlefieldComponentId>();
      const capitalId = world.nations.find((nation) => nation.id === enemyNationId)?.capitalMesoId;
      components = [...topology.regionIdsByComponent.values()]
        .map((regionIds) => buildStructuralComponent(
          world, enemyNationId, [...regionIds].sort(compareIds), capitalId,
          previousComponents, usedPreviousIds,
        ))
        .sort((a, b) => compareIds(a.id, b.id));
      componentsByEnemy.set(enemyNationId, components);
    }
    next.set(key, { attackerNationId, enemyNationId, components });
    const previousCount = state.previousComponentCountByPair.get(key);
    if (previousCount !== undefined && components.length > previousCount) {
      const delta = components.length - previousCount;
      state.componentFragmentationEvents += delta;
      world.instrumentation?.incrementCounter("battlefieldTopology.componentFragmentations", delta);
    }
    state.previousComponentCountByPair.set(key, components.length);
  }
  for (const key of state.activePairKeys) {
    if (activePairs.has(key)) continue;
    const [attacker, enemy] = key.split("|");
    if (attacker > enemy) continue;
    const lastCollapse = Math.max(
      state.lastCollapseTickByPair.get(key) ?? Number.NEGATIVE_INFINITY,
      state.lastCollapseTickByPair.get(`${enemy}|${attacker}`) ?? Number.NEGATIVE_INFINITY,
    );
    if (lastCollapse !== undefined && world.time.fastTick - lastCollapse <= WAR_END_COLLAPSE_WINDOW) {
      state.warsEndingAfterCollapse += 1;
      world.instrumentation?.incrementCounter("battlefieldTopology.warsEndingAfterCollapse");
    }
  }
  state.activePairKeys = activePairs;
  state.structuralByPair = next;
  state.territoryVersion = world.territoryVersion;
  state.occupationVersion = world.occupation.version;
  state.landFrontVersion = world.landFronts.version;
}

function buildStructuralComponent(
  world: WorldState,
  enemyNationId: NationId,
  regionIds: MesoRegionId[],
  capitalId: MesoRegionId | undefined,
  previous: StructuralComponent[],
  usedPreviousIds: Set<BattlefieldComponentId>,
): StructuralComponent {
  const regionSet = new Set(regionIds);
  const containsCapital = !!capitalId && regionSet.has(capitalId);
  const previousMatch = [...previous].filter((component) => !usedPreviousIds.has(component.id))
    .map((component) => ({ component, overlap: component.regionIds.filter((id) => regionSet.has(id)).length }))
    .sort((a, b) => b.overlap - a.overlap || compareIds(a.component.id, b.component.id))[0];
  const id = previousMatch && previousMatch.overlap > 0
    ? previousMatch.component.id
    : `${enemyNationId}:${regionIds[0] ?? "empty"}` as BattlefieldComponentId;
  usedPreviousIds.add(id);
  const analysis = analyzeArticulations(regionIds, getNeighborsById(world), capitalId);
  return {
    id, enemyNationId, regionIds, dfsOrder: analysis.order,
    connectsToStrategicRear: containsCapital,
    articulations: analysis.articulations,
  };
}

function analyzeArticulations(
  regionIds: MesoRegionId[],
  neighbors: ReadonlyMap<MesoRegionId, MesoRegionId[]>,
  capitalId: MesoRegionId | undefined,
): { order: MesoRegionId[]; articulations: StructuralArticulation[] } {
  const allowed = new Set(regionIds);
  const discovery = new Map<MesoRegionId, number>();
  const low = new Map<MesoRegionId, number>();
  const parent = new Map<MesoRegionId, MesoRegionId>();
  const startByRegion = new Map<MesoRegionId, number>();
  const endByRegion = new Map<MesoRegionId, number>();
  const separatedChildren = new Map<MesoRegionId, MesoRegionId[]>();
  const treeChildren = new Map<MesoRegionId, MesoRegionId[]>();
  const order: MesoRegionId[] = [];
  let time = 0;
  const visit = (regionId: MesoRegionId): void => {
    discovery.set(regionId, time); low.set(regionId, time); time += 1;
    startByRegion.set(regionId, order.length); order.push(regionId);
    let childCount = 0;
    for (const neighborId of neighbors.get(regionId) ?? []) {
      if (!allowed.has(neighborId)) continue;
      if (!discovery.has(neighborId)) {
        parent.set(neighborId, regionId); childCount += 1;
        const children = treeChildren.get(regionId) ?? []; children.push(neighborId); treeChildren.set(regionId, children);
        visit(neighborId);
        low.set(regionId, Math.min(low.get(regionId)!, low.get(neighborId)!));
        const root = !parent.has(regionId);
        if (!root && low.get(neighborId)! >= discovery.get(regionId)!) {
          const list = separatedChildren.get(regionId) ?? []; list.push(neighborId);
          separatedChildren.set(regionId, list);
        }
      } else if (parent.get(regionId) !== neighborId) {
        low.set(regionId, Math.min(low.get(regionId)!, discovery.get(neighborId)!));
      }
    }
    endByRegion.set(regionId, order.length);
  };
  for (const regionId of regionIds) if (!discovery.has(regionId)) visit(regionId);
  for (const regionId of regionIds) {
    if (!parent.has(regionId) && (treeChildren.get(regionId)?.length ?? 0) > 1) {
      separatedChildren.set(regionId, [...(treeChildren.get(regionId) ?? [])]);
    }
  }
  const capitalIndex = capitalId ? order.indexOf(capitalId) : -1;
  const articulations: StructuralArticulation[] = [];
  for (const [regionId, children] of [...separatedChildren].sort(([a], [b]) => compareIds(a, b))) {
    const childRanges = children.map((child) => ({
      start: startByRegion.get(child)!, end: endByRegion.get(child)!,
    }));
    const separatedSize = childRanges.reduce((sum, range) => sum + range.end - range.start, 0);
    const remainderSize = regionIds.length - 1 - separatedSize;
    const sizes = childRanges.map((range) => range.end - range.start);
    if (remainderSize > 0) sizes.push(remainderSize);
    const articulationIndex = startByRegion.get(regionId)!;
    const capitalChild = childRanges.find((range) => capitalIndex >= range.start && capitalIndex < range.end);
    const affectedRanges = capitalIndex < 0 || capitalIndex === articulationIndex
      ? childRanges
      : capitalChild
        ? complementRanges(regionIds.length, [capitalChild, { start: articulationIndex, end: articulationIndex + 1 }])
        : childRanges;
    articulations.push({
      regionId,
      resultingComponentSizes: sizes.sort((a, b) => b - a),
      affectedRanges,
    });
  }
  return { order, articulations };
}

function complementRanges(length: number, excluded: Range[]): Range[] {
  const ordered = [...excluded].sort((a, b) => a.start - b.start);
  const result: Range[] = [];
  let cursor = 0;
  for (const range of ordered) {
    if (cursor < range.start) result.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < length) result.push({ start: cursor, end: length });
  return result;
}

function materializeAssessment(
  world: WorldState,
  structure: StructuralAssessment,
  topologyVersion: number,
): BattlefieldTopologyAssessment {
  const meso = getMesoById(world);
  const enemyStrengthByRegion = getEnemyStrengthByRegion(world, structure.attackerNationId);
  const contacts = buildContactCounts(world, structure.attackerNationId, structure.enemyNationId);
  const components: EnemyTopologyComponent[] = [];
  const articulations: BattlefieldArticulationRegion[] = [];
  const corridors: EscapeCorridor[] = [];
  for (const structural of structure.components) {
    const component = materializeComponent(structural, meso, enemyStrengthByRegion, contacts);
    components.push(component);
    const prefixes = buildPrefixes(structural.dfsOrder, meso, enemyStrengthByRegion, contacts.frontlineByRegion);
    for (const item of structural.articulations) {
      const affected = sumRanges(item.affectedRanges, prefixes);
      const articulation: BattlefieldArticulationRegion = {
        regionId: item.regionId, componentId: structural.id,
        resultingComponentSizes: item.resultingComponentSizes,
        affectedRegionCount: affected.regions,
        enemyStrengthAffected: affected.strength,
        citiesAffected: affected.cities,
        capitalAffected: affected.capitals > 0,
        frontlineContactsAffected: affected.contacts,
      };
      articulations.push(articulation);
      if (structural.connectsToStrategicRear && affected.regions > 0 && affected.contacts > 0) {
        corridors.push({
          regionId: item.regionId, componentId: structural.id, exitCount: 1,
          affectedRegionCount: affected.regions,
          enemyStrengthAffected: affected.strength,
          citiesAffected: affected.cities,
          frontlineContactsAffected: affected.contacts,
        });
      }
    }
  }
  for (const component of components) {
    const escapeCount = corridors.filter((corridor) => corridor.componentId === component.id).length;
    component.exitCount = !component.connectsToStrategicRear ? 0 : escapeCount === 1 ? 1 : 2;
  }
  const opportunities = buildCollapseOpportunities(
    world, structure.attackerNationId, structure.enemyNationId,
    components, corridors, enemyStrengthByRegion,
  );
  return {
    attackerNationId: structure.attackerNationId,
    enemyNationId: structure.enemyNationId,
    enemyComponents: components,
    articulationRegions: articulations,
    escapeCorridors: corridors,
    collapseComponents: components.filter((component) =>
      opportunities.some((opportunity) => opportunity.componentId === component.id),
    ),
    pocketCandidates: components.filter((component) => component.exitCount <= 1),
    collapseOpportunities: opportunities,
    topologyVersion, evaluatedAtTick: world.time.fastTick,
  };
}

function materializeComponent(
  structural: StructuralComponent,
  meso: ReturnType<typeof getMesoById>,
  strengths: ReadonlyMap<MesoRegionId, number>,
  contacts: ReturnType<typeof buildContactCounts>,
): EnemyTopologyComponent {
  const frontlineContactCount = structural.regionIds.reduce((sum, id) => sum + (contacts.frontlineByRegion.get(id) ?? 0), 0);
  const friendlyAttackContactCount = structural.regionIds.reduce((sum, id) => sum + (contacts.attackByRegion.get(id) ?? 0), 0);
  return {
    id: structural.id, enemyNationId: structural.enemyNationId,
    regionIds: structural.regionIds, regionCount: structural.regionIds.length,
    frontlineContactCount, friendlyAttackContactCount,
    enemyStrength: structural.regionIds.reduce((sum, id) => sum + (strengths.get(id) ?? 0), 0),
    cities: structural.regionIds.filter((id) => meso.get(id)?.building === "city").length,
    hasCapital: structural.regionIds.some((id) => meso.get(id)?.building === "capital"),
    exitCount: structural.connectsToStrategicRear ? 2 : 0,
    connectsToStrategicRear: structural.connectsToStrategicRear,
  };
}

function buildCollapseOpportunities(
  world: WorldState,
  attackerNationId: NationId,
  enemyNationId: NationId,
  components: EnemyTopologyComponent[],
  corridors: EscapeCorridor[],
  enemyStrengthByRegion: ReadonlyMap<MesoRegionId, number>,
): CollapseOpportunity[] {
  const result: CollapseOpportunity[] = [];
  for (const sector of world.landFronts.operationalSectors) {
    const friendly = getFrontSide(sector, attackerNationId);
    const enemy = getOpposingFrontSide(sector, attackerNationId);
    if (!friendly || !enemy || enemy.nationId !== enemyNationId) continue;
    const enemyInfluence = new Set(enemy.influenceRegionIds);
    const component = components.filter((item) => item.regionIds.some((id) => enemyInfluence.has(id)))
      .sort((a, b) => b.frontlineContactCount - a.frontlineContactCount || compareIds(a.id, b.id))[0];
    if (!component) continue;
    const coverage = getFrontlineCoverage(world, sector.id, enemyNationId);
    const positions = coverage?.positions ?? [];
    const localDefenderStrength = coverage?.defenderStrength ?? enemy.influenceRegionIds.reduce(
      (sum, regionId) => sum + (enemyStrengthByRegion.get(regionId) ?? 0),
      0,
    );
    const undefendedContact = positions.length === 0 && localDefenderStrength <= 0;
    const gapRatio = positions.length > 0 ? (coverage?.gapSegments ?? 0) / positions.length : 0;
    const defendedPositions = positions.filter((position) => position.defenderStrength > 0).length;
    const reasons: CollapseTopologyReason[] = [];
    let score = 0;
    if (!component.connectsToStrategicRear) { reasons.push("isolated-component"); score += 3; }
    const corridor = corridors.filter((item) => item.componentId === component.id && enemyInfluence.has(item.regionId))
      .sort((a, b) => b.affectedRegionCount - a.affectedRegionCount || compareIds(a.regionId, b.regionId))[0];
    if (corridor) { reasons.push("single-exit-component"); score += 2; }
    if (undefendedContact) { reasons.push("front-contact-lost"); score += 2; }
    if (localDefenderStrength <= WORLD_BALANCE.war.landFront.collapseAdvance.collapsedDefenseStrength) {
      reasons.push("low-defender-strength"); score += 1;
    }
    if ((coverage?.maxGapLength ?? 0) >= 2 || gapRatio >= 0.5 || undefendedContact) {
      reasons.push("continuous-gap"); score += 2;
    }
    if (undefendedContact || (positions.length > 0 && (coverage?.gapSegments ?? 0) > 0 && defendedPositions * 2 <= positions.length)) {
      reasons.push("enemy-front-fragmented"); score += 2;
    }
    if ((coverage?.gapSegments ?? 0) > 0 && component.regionCount > component.frontlineContactCount) {
      reasons.push("rear-access-open"); score += 1;
    }
    const target = corridor?.regionId ?? selectOpenTarget(component, enemy.borderRegionIds, enemy.influenceRegionIds, world);
    if (score < 3 || !target) continue;
    result.push({
      attackerNationId, enemyNationId, sectorId: sector.id, componentId: component.id,
      targetRegionId: target, score, reasonFlags: reasons,
      enemyStrength: component.enemyStrength,
      defenderStrength: localDefenderStrength,
      regionCount: component.regionCount, exitCount: corridor ? 1 : component.exitCount,
      detectedAtTick: world.time.fastTick,
    });
  }
  return result.sort((a, b) => b.score - a.score || compareIds(a.sectorId, b.sectorId));
}

function selectOpenTarget(
  component: EnemyTopologyComponent,
  borderIds: readonly MesoRegionId[],
  influenceIds: readonly MesoRegionId[],
  world: WorldState,
): MesoRegionId | undefined {
  const componentIds = new Set(component.regionIds);
  const candidates = [...new Set([...borderIds, ...influenceIds])]
    .filter((id) => componentIds.has(id))
    .sort((a, b) => {
      const buildingA = getMesoById(world).get(a)?.building;
      const buildingB = getMesoById(world).get(b)?.building;
      const scoreA = buildingA === "capital" ? 2 : buildingA === "city" ? 1 : 0;
      const scoreB = buildingB === "capital" ? 2 : buildingB === "city" ? 1 : 0;
      return scoreB - scoreA || compareIds(a, b);
    });
  return candidates[0];
}

function buildContactCounts(world: WorldState, attacker: NationId, enemy: NationId) {
  const frontlineByRegion = new Map<MesoRegionId, number>();
  const attackByRegion = new Map<MesoRegionId, number>();
  for (const sector of world.landFronts.operationalSectors) {
    const friendly = getFrontSide(sector, attacker);
    const opposing = getOpposingFrontSide(sector, attacker);
    if (!friendly || !opposing || opposing.nationId !== enemy) continue;
    for (const id of opposing.borderRegionIds) frontlineByRegion.set(id, (frontlineByRegion.get(id) ?? 0) + 1);
    for (const edge of sector.borderEdges) {
      const enemyId = opposing.borderRegionIds.includes(edge.regionAId) ? edge.regionAId : edge.regionBId;
      attackByRegion.set(enemyId, (attackByRegion.get(enemyId) ?? 0) + 1);
    }
  }
  return { frontlineByRegion, attackByRegion };
}

function buildPrefixes(
  order: MesoRegionId[],
  meso: ReturnType<typeof getMesoById>,
  strengths: ReadonlyMap<MesoRegionId, number>,
  contacts: ReadonlyMap<MesoRegionId, number>,
) {
  const strength = [0], cities = [0], capitals = [0], frontline = [0];
  for (const id of order) {
    strength.push(strength.at(-1)! + (strengths.get(id) ?? 0));
    cities.push(cities.at(-1)! + Number(meso.get(id)?.building === "city"));
    capitals.push(capitals.at(-1)! + Number(meso.get(id)?.building === "capital"));
    frontline.push(frontline.at(-1)! + (contacts.get(id) ?? 0));
  }
  return { strength, cities, capitals, frontline };
}

function sumRanges(ranges: Range[], prefixes: ReturnType<typeof buildPrefixes>) {
  const sum = (values: number[]) => ranges.reduce((total, range) => total + values[range.end] - values[range.start], 0);
  return { regions: ranges.reduce((total, range) => total + range.end - range.start, 0),
    strength: sum(prefixes.strength), cities: sum(prefixes.cities),
    capitals: sum(prefixes.capitals), contacts: sum(prefixes.frontline) };
}

function opportunityKey(opportunity: CollapseOpportunity): string {
  return `${opportunity.attackerNationId}|${opportunity.enemyNationId}|${opportunity.sectorId}|${opportunity.componentId}`;
}
function pairKey(attacker: NationId, enemy: NationId): string { return `${attacker}|${enemy}`; }
function compareAssessments(a: BattlefieldTopologyAssessment, b: BattlefieldTopologyAssessment): number {
  return compareIds(a.attackerNationId, b.attackerNationId) || compareIds(a.enemyNationId, b.enemyNationId);
}
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
