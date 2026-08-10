import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getBattlefieldTopologyAssessment,
  type BattlefieldComponentId,
  type PocketClosureOpportunity,
} from "./battlefield-topology";
import { getFrontSide, getOpposingFrontSide, type FrontId } from "./land-fronts";
import type { SupplyComponentId } from "./supply-assessment";
import { getUnitCombatStrength } from "./unit-strength";
import type { UnitId } from "./unit";
import type { WorldState } from "./world-state";
import { getMesoById } from "./world-cache";

export type SupplyCutoffReason =
  | "supply-cutoff"
  | "major-force-isolation"
  | "frontline-supply-cutoff"
  | "port-supply-cutoff"
  | "pocket-and-supply-cutoff";

export type SupplyCutoffSourceKind = "capital-network" | "maritime" | "mixed";
export type SupplyCutoffStateLabel = "cut" | "sustained" | "reconnected" | "failed";

export interface SupplyCutoffScoreComponents {
  strength: number;
  units: number;
  regions: number;
  cities: number;
  ports: number;
  frontline: number;
  majorForce: number;
  pocketSynergy: number;
  localDefense: number;
}

export interface SupplyCutoffCandidate {
  key: string;
  attackerNationId: NationId;
  enemyNationId: NationId;
  sectorId: FrontId;
  targetRegionId: MesoRegionId;
  battlefieldComponentId: BattlefieldComponentId;
  affectedComponentIds: SupplyComponentId[];
  affectedRegionIds: MesoRegionId[];
  affectedRegionCount: number;
  affectedUnitIds: UnitId[];
  affectedUnitCount: number;
  affectedStrength: number;
  affectedCities: number;
  affectedPorts: number;
  capitalAffected: boolean;
  frontlineAffected: boolean;
  majorForceAffected: boolean;
  currentlySupplied: true;
  predictedIsolated: true;
  sourceKind: SupplyCutoffSourceKind;
  tacticalFeasibility: boolean;
  localAttackerStrength: number;
  localDefenderStrength: number;
  localStrengthRatio: number;
  scoreComponents: SupplyCutoffScoreComponents;
  score: number;
  reasonFlags: SupplyCutoffReason[];
  pocketClosure: PocketClosureOpportunity | null;
  attackerSupplyRiskFlags: string[];
  evaluatedAtTick: number;
}

export interface SupplyCutoffConfirmation {
  state: SupplyCutoffStateLabel;
  confirmedAtTick: number;
  lastEvaluatedAtTick: number;
  sustainedAtTick: number | null;
  reconnectedAtTick: number | null;
  predictedStrength: number;
  actualIsolatedStrength: number;
  predictedComponentIds: SupplyComponentId[];
  actualComponentIds: SupplyComponentId[];
  actualRegionIds: MesoRegionId[];
  actualUnitCount: number;
  actualCities: number;
  actualPorts: number;
  mismatchReason: string | null;
}

export interface SupplyCutoffAnalysisState {
  candidates: SupplyCutoffCandidate[];
  candidatesByKey: Map<string, SupplyCutoffCandidate>;
  version: number;
  candidatesEvaluated: number;
  meaningfulCandidates: number;
  operationsCreated: number;
  attacksLaunched: number;
  targetCaptures: number;
  successfulCutoffs: number;
  failedCutoffs: number;
  predictedIsolatedStrength: number;
  actualIsolatedStrength: number;
  isolatedUnits: number;
  isolatedRegions: number;
  isolatedCities: number;
  isolatedPorts: number;
  frontlineComponentsIsolated: number;
  cutoffToIsolationTicks: number;
  cutoffToIsolationSamples: number;
  isolationDurationTicks: number;
  sustainedCutoffs: number;
  reconnections: number;
  attackerCorridorRiskCount: number;
  tacticalScoreTotal: number;
  supplyScoreTotal: number;
  scoreSamples: number;
  cutoffToPocketReduction: number;
  cutoffToCollapseAdvance: number;
  cutoffToSurrender: number;
  correlatedPocketOperationIds: Set<string>;
  correlatedCollapseOperationIds: Set<string>;
  correlatedSurrenderOperationIds: Set<string>;
}

export function createSupplyCutoffAnalysisState(): SupplyCutoffAnalysisState {
  return {
    candidates: [],
    candidatesByKey: new Map(),
    version: 0,
    candidatesEvaluated: 0,
    meaningfulCandidates: 0,
    operationsCreated: 0,
    attacksLaunched: 0,
    targetCaptures: 0,
    successfulCutoffs: 0,
    failedCutoffs: 0,
    predictedIsolatedStrength: 0,
    actualIsolatedStrength: 0,
    isolatedUnits: 0,
    isolatedRegions: 0,
    isolatedCities: 0,
    isolatedPorts: 0,
    frontlineComponentsIsolated: 0,
    cutoffToIsolationTicks: 0,
    cutoffToIsolationSamples: 0,
    isolationDurationTicks: 0,
    sustainedCutoffs: 0,
    reconnections: 0,
    attackerCorridorRiskCount: 0,
    tacticalScoreTotal: 0,
    supplyScoreTotal: 0,
    scoreSamples: 0,
    cutoffToPocketReduction: 0,
    cutoffToCollapseAdvance: 0,
    cutoffToSurrender: 0,
    correlatedPocketOperationIds: new Set(),
    correlatedCollapseOperationIds: new Set(),
    correlatedSurrenderOperationIds: new Set(),
  };
}

export function updateSupplyCutoffAnalysis(world: WorldState): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.supplyCutoffs;
  const candidates: SupplyCutoffCandidate[] = [];
  const unitsByNationRegion = indexLandUnits(world);

  for (const assessment of world.battlefieldTopology.assessments) {
    const enemySupply = world.supplyAssessment.assessmentByNationId.get(
      assessment.enemyNationId,
    );
    if (!enemySupply) continue;
    const sourceIdsByComponent = getActiveSourceIdsByComponent(world, assessment.enemyNationId);
    const articulationByRegionId = new Map(
      assessment.articulationRegions.map((item) => [item.regionId, item]),
    );
    const structuralTargetIds = new Set<MesoRegionId>([
      ...articulationByRegionId.keys(),
      ...[...sourceIdsByComponent.values()].flatMap((ids) => [...ids]),
      ...assessment.pocketClosureOpportunities.map((item) => item.candidateRegionId),
    ]);
    for (const targetRegionId of [...structuralTargetIds].sort(compareIds)) {
      const supplyComponentId = enemySupply.componentIdByRegionId.get(targetRegionId);
      const supplyComponent = supplyComponentId
        ? enemySupply.componentById.get(supplyComponentId)
        : undefined;
      if (!supplyComponent?.supplied || !supplyComponentId) continue;
      const sources = sourceIdsByComponent.get(supplyComponentId) ?? new Set();
      const articulation = articulationByRegionId.get(targetRegionId);
      const affectedRegionIds = predictAffectedRegions(
        targetRegionId,
        supplyComponent.regionIds,
        sources,
        articulation?.resultingRegionGroups,
      );
      state.candidatesEvaluated += 1;
      world.instrumentation?.incrementCounter("supplyCutoff.candidatesEvaluated");
      if (affectedRegionIds.length === 0) continue;
      const affectedSet = new Set(affectedRegionIds);
      const affectedUnits = affectedRegionIds.flatMap((regionId) =>
        unitsByNationRegion.get(assessment.enemyNationId)?.get(regionId) ?? []
      );
      const affectedStrength = affectedUnits.reduce(
        (sum, unit) => sum + getUnitCombatStrength(unit),
        0,
      );
      const affectedCities = affectedRegionIds.filter((regionId) =>
        getMesoById(world).get(regionId)?.building === "city"
      ).length;
      const affectedPorts = affectedRegionIds.filter((regionId) =>
        getMesoById(world).get(regionId)?.building === "port"
      ).length + (getMesoById(world).get(targetRegionId)?.building === "port" ? 1 : 0);
      const capitalAffected = affectedRegionIds.some((regionId) =>
        getMesoById(world).get(regionId)?.building === "capital"
      ) || getMesoById(world).get(targetRegionId)?.building === "capital";
      const meaningful = isMeaningfulCutoff(
        affectedStrength,
        affectedUnits.length,
        affectedRegionIds.length,
        affectedCities,
        affectedPorts,
        capitalAffected,
      );
      if (!meaningful) continue;
      state.meaningfulCandidates += 1;
      world.instrumentation?.incrementCounter("supplyCutoff.meaningfulCandidates");
      for (const sector of world.landFronts.operationalSectors) {
        const friendly = getFrontSide(sector, assessment.attackerNationId);
        const enemy = getOpposingFrontSide(sector, assessment.attackerNationId);
        if (!friendly || enemy?.nationId !== assessment.enemyNationId ||
            !enemy.influenceRegionIds.includes(targetRegionId)) continue;
        const localDefenderStrength = unitsByNationRegion
          .get(assessment.enemyNationId)?.get(targetRegionId)
          ?.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0) ?? 0;
        const localAttackerStrength = Math.max(0, friendly.strength);
        const localStrengthRatio = localDefenderStrength <= 0
          ? (localAttackerStrength > 0 ? 100 : 0)
          : Math.min(100, localAttackerStrength / localDefenderStrength);
        const tacticalFeasibility = localAttackerStrength > 0 &&
          localStrengthRatio >=
            WORLD_BALANCE.war.landFront.pocketClosure.minimumLocalStrengthRatio;
        const frontlineAffected = (articulation?.frontlineContactsAffected ?? 0) > 0 ||
          affectedRegionIds.some((regionId) => enemy.borderRegionIds.includes(regionId));
        const majorForceAffected = isMajorForceAffected(
          world,
          assessment.enemyNationId,
          new Set(affectedUnits.map((unit) => unit.id)),
        );
        const closure = assessment.pocketClosureOpportunities.find((item) =>
          item.sectorId === sector.id && item.candidateRegionId === targetRegionId
        ) ?? null;
        const sourceKind = getSourceKind(world, supplyComponentId, sources);
        const scoreComponents = scoreCandidate(
          affectedStrength,
          affectedUnits.length,
          affectedRegionIds.length,
          affectedCities,
          affectedPorts,
          frontlineAffected,
          majorForceAffected,
          !!closure,
          localStrengthRatio,
        );
        const reasonFlags: SupplyCutoffReason[] = ["supply-cutoff"];
        if (majorForceAffected ||
            affectedStrength >= WORLD_BALANCE.war.landFront.supplyCutoff.majorStrengthThreshold) {
          reasonFlags.push("major-force-isolation");
        }
        if (frontlineAffected) reasonFlags.push("frontline-supply-cutoff");
        if (sourceKind !== "capital-network" || affectedPorts > 0) {
          reasonFlags.push("port-supply-cutoff");
        }
        if (closure) reasonFlags.push("pocket-and-supply-cutoff");
        const riskFlags = getAttackerSupplyRiskFlags(
          world,
          assessment.attackerNationId,
          assessment.enemyNationId,
          sector.id,
        );
        if (riskFlags.length > 0) state.attackerCorridorRiskCount += 1;
        candidates.push({
          key: cutoffKey(assessment.attackerNationId, assessment.enemyNationId, sector.id, targetRegionId),
          attackerNationId: assessment.attackerNationId,
          enemyNationId: assessment.enemyNationId,
          sectorId: sector.id,
          targetRegionId,
          battlefieldComponentId: articulation?.componentId ??
            assessment.enemyComponents.find((component) =>
              component.regionIds.includes(targetRegionId)
            )?.id ?? `${assessment.enemyNationId}:${targetRegionId}` as BattlefieldComponentId,
          affectedComponentIds: [supplyComponentId],
          affectedRegionIds,
          affectedRegionCount: affectedRegionIds.length,
          affectedUnitIds: affectedUnits.map((unit) => unit.id).sort(compareIds),
          affectedUnitCount: affectedUnits.length,
          affectedStrength,
          affectedCities,
          affectedPorts,
          capitalAffected,
          frontlineAffected,
          majorForceAffected,
          currentlySupplied: true,
          predictedIsolated: true,
          sourceKind,
          tacticalFeasibility,
          localAttackerStrength,
          localDefenderStrength,
          localStrengthRatio,
          scoreComponents,
          score: Object.values(scoreComponents).reduce((sum, value) => sum + value, 0),
          reasonFlags,
          pocketClosure: closure,
          attackerSupplyRiskFlags: riskFlags,
          evaluatedAtTick: world.time.fastTick,
        });
      }
    }
  }

  state.candidates = candidates.sort((a, b) =>
    Number(b.tacticalFeasibility) - Number(a.tacticalFeasibility) ||
    b.score - a.score || compareIds(a.key, b.key)
  );
  state.candidatesByKey = new Map(state.candidates.map((candidate) => [candidate.key, candidate]));
  state.version += 1;
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "supplyCutoff.analysis",
      performance.now() - startedAt,
    );
  }
}

export function getSupplyCutoffCandidate(
  world: WorldState,
  attackerNationId: NationId,
  enemyNationId: NationId,
  sectorId: FrontId,
  targetRegionId: MesoRegionId,
): SupplyCutoffCandidate | undefined {
  return world.supplyCutoffs.candidatesByKey.get(
    cutoffKey(attackerNationId, enemyNationId, sectorId, targetRegionId),
  );
}

export function cloneSupplyCutoffCandidate(
  candidate: SupplyCutoffCandidate,
): SupplyCutoffCandidate {
  return {
    ...candidate,
    affectedComponentIds: [...candidate.affectedComponentIds],
    affectedRegionIds: [...candidate.affectedRegionIds],
    affectedUnitIds: [...candidate.affectedUnitIds],
    scoreComponents: { ...candidate.scoreComponents },
    reasonFlags: [...candidate.reasonFlags],
    pocketClosure: candidate.pocketClosure ? {
      ...candidate.pocketClosure,
      affectedRegionIds: [...candidate.pocketClosure.affectedRegionIds],
      scoreComponents: { ...candidate.pocketClosure.scoreComponents },
    } : null,
    attackerSupplyRiskFlags: [...candidate.attackerSupplyRiskFlags],
  };
}

export function isSupplyCutoffStillValid(
  world: WorldState,
  objective: SupplyCutoffCandidate,
): boolean {
  const current = getSupplyCutoffCandidate(
    world,
    objective.attackerNationId,
    objective.enemyNationId,
    objective.sectorId,
    objective.targetRegionId,
  );
  if (!current) return false;
  const expected = new Set(objective.affectedRegionIds);
  return current.affectedRegionIds.some((regionId) => expected.has(regionId));
}

export function verifySupplyCutoff(
  world: WorldState,
  objective: SupplyCutoffCandidate,
): SupplyCutoffConfirmation {
  const expected = new Set(objective.affectedRegionIds);
  const assessment = world.supplyAssessment.assessmentByNationId.get(objective.enemyNationId);
  const actualComponents = assessment?.components.filter((component) =>
    component.isolated && component.regionIds.some((regionId) => expected.has(regionId))
  ) ?? [];
  const actualRegionIds = [...new Set(actualComponents.flatMap((component) =>
    component.regionIds.filter((regionId) => expected.has(regionId))
  ))].sort(compareIds);
  const actualSet = new Set(actualRegionIds);
  const actualUnits = world.units.filter((unit) =>
    unit.domain === "land" && unit.nationId === objective.enemyNationId && actualSet.has(unit.regionId)
  );
  const actualIsolatedStrength = actualUnits.reduce(
    (sum, unit) => sum + getUnitCombatStrength(unit),
    0,
  );
  const success = actualRegionIds.length > 0 && isMeaningfulCutoff(
    actualIsolatedStrength,
    actualUnits.length,
    actualRegionIds.length,
    actualRegionIds.filter((regionId) => getMesoById(world).get(regionId)?.building === "city").length,
    actualRegionIds.filter((regionId) => getMesoById(world).get(regionId)?.building === "port").length,
    actualRegionIds.some((regionId) => getMesoById(world).get(regionId)?.building === "capital"),
  );
  return {
    state: success ? "cut" : "failed",
    confirmedAtTick: world.time.fastTick,
    lastEvaluatedAtTick: world.time.fastTick,
    sustainedAtTick: null,
    reconnectedAtTick: null,
    predictedStrength: objective.affectedStrength,
    actualIsolatedStrength,
    predictedComponentIds: [...objective.affectedComponentIds],
    actualComponentIds: actualComponents.map((component) => component.id).sort(compareIds),
    actualRegionIds,
    actualUnitCount: actualUnits.length,
    actualCities: actualRegionIds.filter((regionId) =>
      getMesoById(world).get(regionId)?.building === "city"
    ).length,
    actualPorts: actualRegionIds.filter((regionId) =>
      getMesoById(world).get(regionId)?.building === "port"
    ).length,
    mismatchReason: success ? null : "alternate-supply-source-active-or-no-isolated-overlap",
  };
}

function predictAffectedRegions(
  targetRegionId: MesoRegionId,
  componentRegionIds: readonly MesoRegionId[],
  sourceIds: ReadonlySet<MesoRegionId>,
  resultingGroups: readonly MesoRegionId[][] | undefined,
): MesoRegionId[] {
  if (resultingGroups) {
    return [...new Set(resultingGroups
      .filter((group) => !group.some((regionId) => sourceIds.has(regionId)))
      .flat())].sort(compareIds);
  }
  if (!sourceIds.has(targetRegionId)) return [];
  if ([...sourceIds].some((regionId) => regionId !== targetRegionId)) return [];
  return componentRegionIds.filter((regionId) => regionId !== targetRegionId).sort(compareIds);
}

function getActiveSourceIdsByComponent(
  world: WorldState,
  nationId: NationId,
): Map<SupplyComponentId, Set<MesoRegionId>> {
  const result = new Map<SupplyComponentId, Set<MesoRegionId>>();
  const assessment = world.supplyAssessment.assessmentByNationId.get(nationId);
  if (!assessment) return result;
  const rootComponentIds = new Set<SupplyComponentId>();
  const add = (componentId: SupplyComponentId, regionId: MesoRegionId): void => {
    const ids = result.get(componentId) ?? new Set<MesoRegionId>();
    ids.add(regionId);
    result.set(componentId, ids);
  };
  for (const regionId of assessment.supplySourceRegionIds) {
    const componentId = assessment.componentIdByRegionId.get(regionId);
    if (componentId) {
      rootComponentIds.add(componentId);
      add(componentId, regionId);
    }
  }
  for (const link of world.supplyAssessment.maritimeLinks) {
    if (!link.active || link.nationId !== nationId || !link.destinationLandComponentId ||
        !link.sourceLandComponentId) continue;
    if (!hasIndependentUpstreamSource(
      world,
      nationId,
      link.sourceLandComponentId,
      link.destinationLandComponentId,
      rootComponentIds,
    )) continue;
    add(link.destinationLandComponentId, link.destinationPortId);
  }
  return result;
}

function hasIndependentUpstreamSource(
  world: WorldState,
  nationId: NationId,
  startId: SupplyComponentId,
  excludedId: SupplyComponentId,
  rootIds: ReadonlySet<SupplyComponentId>,
): boolean {
  if (startId === excludedId) return false;
  const visited = new Set<SupplyComponentId>([excludedId]);
  const stack = [startId];
  while (stack.length > 0) {
    const componentId = stack.pop()!;
    if (visited.has(componentId)) continue;
    visited.add(componentId);
    if (rootIds.has(componentId)) return true;
    for (const link of world.supplyAssessment.maritimeLinks) {
      if (!link.active || link.nationId !== nationId ||
          link.destinationLandComponentId !== componentId ||
          !link.sourceLandComponentId || visited.has(link.sourceLandComponentId)) continue;
      stack.push(link.sourceLandComponentId);
    }
  }
  return false;
}

function getSourceKind(
  world: WorldState,
  componentId: SupplyComponentId,
  sources: ReadonlySet<MesoRegionId>,
): SupplyCutoffSourceKind {
  const maritime = world.supplyAssessment.maritimeLinks.some((link) =>
    link.active && link.destinationLandComponentId === componentId &&
    sources.has(link.destinationPortId)
  );
  const capital = [...world.supplyAssessment.assessments].some((assessment) =>
    assessment.supplySourceRegionIds.some((regionId) => sources.has(regionId))
  );
  return maritime && capital ? "mixed" : maritime ? "maritime" : "capital-network";
}

function isMeaningfulCutoff(
  strength: number,
  units: number,
  regions: number,
  cities: number,
  ports: number,
  capital: boolean,
): boolean {
  const settings = WORLD_BALANCE.war.landFront.supplyCutoff;
  return strength >= settings.minimumMeaningfulStrength ||
    units >= settings.minimumMeaningfulUnits ||
    cities > 0 || ports > 0 || capital ||
    (regions >= settings.minimumMeaningfulRegions && units > 0);
}

function scoreCandidate(
  strength: number,
  units: number,
  regions: number,
  cities: number,
  ports: number,
  frontline: boolean,
  majorForce: boolean,
  pocket: boolean,
  localStrengthRatio: number,
): SupplyCutoffScoreComponents {
  const settings = WORLD_BALANCE.war.landFront.supplyCutoff.score;
  return {
    strength: Math.min(
      settings.maximumStrength,
      Math.sqrt(Math.max(0, strength) / settings.strengthReference) * settings.strengthScale,
    ),
    units: Math.min(settings.maximumUnits, units * settings.perUnit),
    regions: Math.min(settings.maximumRegions, regions * settings.perRegion),
    cities: cities * settings.perCity,
    ports: ports * settings.perPort,
    frontline: frontline ? settings.frontline : 0,
    majorForce: majorForce ? settings.majorForce : 0,
    pocketSynergy: pocket ? settings.pocketSynergy : 0,
    localDefense: localStrengthRatio < 1
      ? -settings.localDefensePenalty * (1 - localStrengthRatio)
      : 0,
  };
}

function isMajorForceAffected(
  world: WorldState,
  enemyNationId: NationId,
  affectedUnitIds: ReadonlySet<UnitId>,
): boolean {
  const operationForce = world.offensiveOperations.operations.some((operation) =>
    operation.nationId === enemyNationId &&
    operation.assignedUnitIds.some((unitId) => affectedUnitIds.has(unitId))
  );
  const reserveForce = world.strategicReserves.reserves.some((reserve) =>
    reserve.nationId === enemyNationId && reserve.unitIds.some((unitId) => affectedUnitIds.has(unitId))
  );
  return operationForce || reserveForce;
}

function getAttackerSupplyRiskFlags(
  world: WorldState,
  attackerNationId: NationId,
  enemyNationId: NationId,
  sectorId: FrontId,
): string[] {
  const reverse = getBattlefieldTopologyAssessment(world, enemyNationId, attackerNationId);
  const sector = world.landFronts.operationalSectorsById.get(sectorId);
  const friendly = sector ? getFrontSide(sector, attackerNationId) : undefined;
  if (!reverse || !friendly) return [];
  const risky = reverse.articulationRegions.some((item) =>
    item.enemyStrengthAffected > 0 && friendly.influenceRegionIds.includes(item.regionId)
  );
  return risky ? ["own-narrow-supply-corridor"] : [];
}

function indexLandUnits(world: WorldState) {
  const result = new Map<NationId, Map<MesoRegionId, WorldState["units"]>>();
  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    const byRegion = result.get(unit.nationId) ?? new Map<MesoRegionId, WorldState["units"]>();
    const units = byRegion.get(unit.regionId) ?? [];
    units.push(unit);
    byRegion.set(unit.regionId, units);
    result.set(unit.nationId, byRegion);
  }
  return result;
}

function cutoffKey(
  attackerNationId: NationId,
  enemyNationId: NationId,
  sectorId: FrontId,
  targetRegionId: MesoRegionId,
): string {
  return `${attackerNationId}|${enemyNationId}|${sectorId}|${targetRegionId}`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
