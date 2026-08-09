import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getFrontSide, getOpposingFrontSide, type SectorId } from "./land-fronts";
import { getFrontAllocation } from "./nation-front-allocations";
import { getFrontPlan } from "./nation-front-plans";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";
import { isSchwerpunktSector } from "./stalemate-pressure";
import { getMesoById, getNeighborsById } from "./world-cache";

export type FrontlineCoverageLevel = "covered" | "weak" | "gap";
export type DefensivePositionId = string & { __brand: "DefensivePositionId" };

export interface FrontlineDefensivePosition {
  id: DefensivePositionId;
  sectorId: SectorId;
  nationId: NationId;
  segmentIndex: number;
  friendlyRegionId: MesoRegionId;
  enemyRegionIds: MesoRegionId[];
  defenderUnitIds: UnitId[];
  defenderStrength: number;
  requiredStrength: number;
  threat: number;
  urgency: number;
  state: FrontlineCoverageLevel;
}

export interface SectorFrontlineCoverage {
  sectorId: SectorId;
  nationId: NationId;
  positions: FrontlineDefensivePosition[];
  coveredSegments: number;
  weakSegments: number;
  gapSegments: number;
  coverageRatio: number;
  averageGapLength: number;
  maxGapLength: number;
  defenderCount: number;
  defenderStrength: number;
  minimumRequiredStrength: number;
  offensiveSurplusStrength: number;
  assignmentSwitches: number;
  breakthroughCount: number;
}

export interface FrontlineDefensiveAssignment {
  sectorId: SectorId;
  defensivePositionId: DefensivePositionId;
  targetRegionId: MesoRegionId;
}

export interface FrontlineCoverageState {
  coverages: SectorFrontlineCoverage[];
  coverageBySectorNation: Map<string, SectorFrontlineCoverage>;
  assignmentByUnitId: Map<UnitId, FrontlineDefensiveAssignment>;
  version: number;
  membershipVersion: number;
  sourceAllocationVersion: number;
  sourceFrontVersion: number;
  sourceOperationMembershipVersion: number;
  sourceOperationVersion: number;
  sourceOccupationVersion: number;
  sourceBuildingVersion: number;
  totalAssignmentSwitches: number;
  breakthroughEvents: number;
}

export function createFrontlineCoverageState(): FrontlineCoverageState {
  return {
    coverages: [],
    coverageBySectorNation: new Map(),
    assignmentByUnitId: new Map(),
    version: 0,
    membershipVersion: 0,
    sourceAllocationVersion: -1,
    sourceFrontVersion: -1,
    sourceOperationMembershipVersion: -1,
    sourceOperationVersion: -1,
    sourceOccupationVersion: -1,
    sourceBuildingVersion: -1,
    totalAssignmentSwitches: 0,
    breakthroughEvents: 0,
  };
}

export function getFrontlineCoverage(
  world: WorldState,
  sectorId: SectorId,
  nationId: NationId,
): SectorFrontlineCoverage | undefined {
  return world.frontlineCoverage.coverageBySectorNation.get(key(sectorId, nationId));
}

export function getFrontlineAssignment(
  world: WorldState,
  unitId: UnitId,
): FrontlineDefensiveAssignment | undefined {
  return world.frontlineCoverage.assignmentByUnitId.get(unitId);
}

export function getFrontlineTargetForUnit(
  _world: WorldState,
  unitId: UnitId,
): MesoRegionId | undefined {
  const assignment = getFrontlineAssignment(_world, unitId);
  return assignment?.targetRegionId;
}

export function getOrderedFrontlineRegionIds(
  world: WorldState,
  sectorId: SectorId,
  nationId: NationId,
): MesoRegionId[] {
  return buildPositions(world, sectorId, nationId).map((position) => position.friendlyRegionId);
}

export function updateFrontlineCoverage(world: WorldState): void {
  const state = world.frontlineCoverage;
  world.instrumentation?.incrementCounter("frontlineCoverage.evaluations");
  if (coverageInputIsCurrent(state, world)) {
    world.instrumentation?.incrementCounter("frontlineCoverage.skippedRebuilds");
    world.instrumentation?.incrementCounter("assignment.skippedRebuilds");
    world.instrumentation?.incrementCounter(
      "assignment.reusedUnits",
      state.assignmentByUnitId.size,
    );
    world.instrumentation?.incrementCounter(
      "frontlineCoverage.assignmentReused",
      state.assignmentByUnitId.size,
    );
    return;
  }
  world.instrumentation?.incrementCounter("frontlineCoverage.dirtyRebuilds");

  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousAssignments = state.assignmentByUnitId;
  const previousCoverage = state.coverageBySectorNation;
  const nextAssignments = new Map<UnitId, FrontlineDefensiveAssignment>();
  const coverages: SectorFrontlineCoverage[] = [];
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const strengthByRegionNation = indexLandStrength(world);

  for (const allocation of world.frontAllocations.allocations) {
    const sector = world.landFronts.operationalSectorsById.get(allocation.frontId);
    const friendly = sector ? getFrontSide(sector, allocation.nationId) : undefined;
    const enemy = sector ? getOpposingFrontSide(sector, allocation.nationId) : undefined;
    if (!sector || !friendly || !enemy) continue;
    const positions = buildPositions(
      world,
      sector.id,
      allocation.nationId,
      enemy.nationId,
      strengthByRegionNation,
    );
    if (positions.length === 0) continue;
    const operation = world.offensiveOperations.operationsByFrontNation.get(
      key(sector.id, allocation.nationId),
    );
    const operationIds = new Set(operation && operation.phase !== "recovering" ? operation.assignedUnitIds : []);
    const units = allocation.unitIds.map((id) => unitById.get(id)).filter(
      (unit): unit is UnitState => !!unit && unit.domain === "land" &&
        !operationIds.has(unit.id) && !world.reorganization.planIdByUnitId.has(unit.id),
    );
    const plan = getFrontPlan(world, sector.id, allocation.nationId);
    const ratio = plan?.posture === "attack" || isSchwerpunktSector(world, allocation.nationId, sector.id)
      ? WORLD_BALANCE.war.landFront.frontlineCoverage.attackMinimumStrengthRatio
      : plan?.posture === "retreat"
        ? WORLD_BALANCE.war.landFront.frontlineCoverage.emergencyMinimumStrengthRatio
        : 1;
    const minimumRequiredStrength = Math.max(0, allocation.allocatedStrength) * ratio;
    const desiredCount = Math.min(
      positions.length,
      ratio >= 1 ? units.length : Math.max(1, Math.ceil(units.length * ratio)),
    );
    const selectedUnits = selectDefenders(
      units,
      desiredCount,
      minimumRequiredStrength,
      previousAssignments,
    );
    const targetPositions = selectDistributedPositions(positions, selectedUnits.length);
    assignDefenders(world, sector.id, selectedUnits, targetPositions, previousAssignments, nextAssignments);
    evaluatePositions(world, positions, selectedUnits, nextAssignments, minimumRequiredStrength);
    const gaps = gapLengths(positions);
    const previous = previousCoverage.get(key(sector.id, allocation.nationId));
    const breakthroughs = countBreakthroughs(world, allocation.nationId, previous);
    const coveredSegments = positions.filter((position) => position.state === "covered").length;
    const weakSegments = positions.filter((position) => position.state === "weak").length;
    const gapSegments = positions.length - coveredSegments - weakSegments;
    const defenderStrength = sumStrength(selectedUnits);
    const assignmentSwitches = selectedUnits.filter((unit) => {
      const before = previousAssignments.get(unit.id)?.defensivePositionId;
      const after = nextAssignments.get(unit.id)?.defensivePositionId;
      return !!before && before !== after;
    }).length;
    coverages.push({
      sectorId: sector.id,
      nationId: allocation.nationId,
      positions,
      coveredSegments,
      weakSegments,
      gapSegments,
      coverageRatio: positions.length > 0 ? (coveredSegments + weakSegments * 0.5) / positions.length : 1,
      averageGapLength: gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0,
      maxGapLength: gaps.length ? Math.max(...gaps) : 0,
      defenderCount: selectedUnits.length,
      defenderStrength,
      minimumRequiredStrength,
      offensiveSurplusStrength: Math.max(0, allocation.allocatedStrength - defenderStrength),
      assignmentSwitches,
      breakthroughCount: breakthroughs,
    });
  }

  coverages.sort((a, b) => key(a.sectorId, a.nationId).localeCompare(key(b.sectorId, b.nationId)));
  const switches = countAssignmentChanges(previousAssignments, nextAssignments);
  const breakthroughs = coverages.reduce((sum, coverage) => sum + coverage.breakthroughCount, 0);
  const membershipChanged = !assignmentMapsEqual(previousAssignments, nextAssignments);
  state.coverages = coverages;
  state.coverageBySectorNation = new Map(coverages.map((coverage) => [key(coverage.sectorId, coverage.nationId), coverage]));
  state.assignmentByUnitId = nextAssignments;
  state.sourceAllocationVersion = world.frontAllocations.version;
  state.sourceFrontVersion = world.landFronts.version;
  state.sourceOperationMembershipVersion = world.offensiveOperations.membershipVersion;
  state.sourceOperationVersion = world.offensiveOperations.version;
  state.sourceOccupationVersion = world.occupation.version;
  state.sourceBuildingVersion = world.buildingVersion;
  state.totalAssignmentSwitches += switches;
  state.breakthroughEvents += breakthroughs;
  if (membershipChanged) state.membershipVersion += 1;
  state.version += 1;
  const instrumentation = world.instrumentation;
  if (instrumentation) {
    instrumentation.recordDuration("frontlineCoverage.evaluation", performance.now() - startedAt);
    instrumentation.incrementCounter("frontlineCoverage.segments", coverages.reduce((sum, item) => sum + item.positions.length, 0));
    instrumentation.incrementCounter("frontlineCoverage.coveredSegments", coverages.reduce((sum, item) => sum + item.coveredSegments, 0));
    instrumentation.incrementCounter("frontlineCoverage.weakSegments", coverages.reduce((sum, item) => sum + item.weakSegments, 0));
    instrumentation.incrementCounter("frontlineCoverage.gapSegments", coverages.reduce((sum, item) => sum + item.gapSegments, 0));
    instrumentation.incrementCounter("frontlineCoverage.defenders", nextAssignments.size);
    instrumentation.incrementCounter("frontlineCoverage.defenderStrength", Math.round(coverages.reduce((sum, item) => sum + item.defenderStrength, 0)));
    instrumentation.incrementCounter("frontlineCoverage.assignmentSwitches", switches);
    instrumentation.incrementCounter("frontlineCoverage.operationStrengthWithheld", Math.round(coverages.reduce((sum, item) => sum + item.minimumRequiredStrength, 0)));
    instrumentation.incrementCounter("frontlineCoverage.breakthroughs", breakthroughs);
  }
}

function buildPositions(
  world: WorldState,
  sectorId: SectorId,
  nationId: NationId,
  enemyNationId?: NationId,
  strengthByRegionNation: ReadonlyMap<MesoRegionId, ReadonlyMap<NationId, number>> = new Map(),
): FrontlineDefensivePosition[] {
  const sector = world.landFronts.operationalSectorsById.get(sectorId);
  const friendly = sector && getFrontSide(sector, nationId);
  if (!sector || !friendly) return [];
  const friendlyIds = new Set(friendly.borderRegionIds);
  const neighbors = getNeighborsById(world);
  const adjacency = new Map<MesoRegionId, Set<MesoRegionId>>();
  for (const id of friendlyIds) adjacency.set(id, new Set());
  for (const id of friendlyIds) {
    for (const other of neighbors.get(id) ?? []) if (friendlyIds.has(other)) adjacency.get(id)?.add(other);
  }
  // Edges sharing an enemy-side cell are consecutive along the actual contact geometry.
  const friendlyByEnemy = new Map<MesoRegionId, MesoRegionId[]>();
  for (const edge of sector.borderEdges) {
    const friendlyId = friendlyIds.has(edge.regionAId) ? edge.regionAId : edge.regionBId;
    const enemyId = friendlyId === edge.regionAId ? edge.regionBId : edge.regionAId;
    const list = friendlyByEnemy.get(enemyId);
    if (list) list.push(friendlyId); else friendlyByEnemy.set(enemyId, [friendlyId]);
  }
  for (const ids of friendlyByEnemy.values()) for (const a of ids) for (const b of ids) if (a !== b) adjacency.get(a)?.add(b);
  const ordered = orderTopology([...friendlyIds], adjacency);
  const mesoById = getMesoById(world);
  const opposingNationId = enemyNationId ?? getOpposingFrontSide(sector, nationId)?.nationId;
  const enemyOperation = opposingNationId
    ? world.offensiveOperations.operationsByFrontNation.get(key(sectorId, opposingNationId))
    : undefined;
  const enemyOperationTargets = new Set(
    enemyOperation && enemyOperation.phase !== "recovering"
      ? [
          enemyOperation.primaryTargetRegionId,
          ...enemyOperation.supportingTargetRegionIds,
          ...(enemyOperation.exploitationTargetRegionId
            ? [enemyOperation.exploitationTargetRegionId]
            : []),
        ]
      : [],
  );
  return ordered.map((friendlyRegionId, segmentIndex) => {
    const enemyRegionIds = sector.borderEdges.flatMap((edge) => {
      if (edge.regionAId === friendlyRegionId) return [edge.regionBId];
      if (edge.regionBId === friendlyRegionId) return [edge.regionAId];
      return [];
    }).sort(compareIds);
    const threat = enemyRegionIds.reduce(
      (sum, id) => sum + (opposingNationId ? (strengthByRegionNation.get(id)?.get(opposingNationId) ?? 0) : 0),
      0,
    ) + nearbyBuildingThreat(friendlyRegionId, mesoById, neighbors) +
      (enemyRegionIds.some((id) => enemyOperationTargets.has(id))
        ? WORLD_BALANCE.war.landFront.frontlineCoverage.enemyOperationThreatBonus
        : 0);
    return {
      id: `${sectorId}::${nationId}::${friendlyRegionId}` as DefensivePositionId,
      sectorId, nationId, segmentIndex, friendlyRegionId, enemyRegionIds,
      defenderUnitIds: [], defenderStrength: 0, requiredStrength: 0, threat, state: "gap",
      urgency: 0,
    };
  });
}

function orderTopology(ids: MesoRegionId[], adjacency: ReadonlyMap<MesoRegionId, ReadonlySet<MesoRegionId>>): MesoRegionId[] {
  if (ids.length <= 1) return ids.sort(compareIds);
  const start = [...ids].sort((a, b) => (adjacency.get(a)?.size ?? 0) - (adjacency.get(b)?.size ?? 0) || compareIds(a, b))[0];
  const distance = new Map<MesoRegionId, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const next of [...(adjacency.get(current) ?? [])].sort(compareIds)) {
      if (distance.has(next)) continue;
      distance.set(next, (distance.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  return [...ids].sort((a, b) => (distance.get(a) ?? Number.MAX_SAFE_INTEGER) - (distance.get(b) ?? Number.MAX_SAFE_INTEGER) || compareIds(a, b));
}

function selectDefenders(
  units: UnitState[],
  desiredCount: number,
  requiredStrength: number,
  previous: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>,
): UnitState[] {
  const ordered = [...units].sort((a, b) => {
    const assignedA = previous.has(a.id) ? 1 : 0;
    const assignedB = previous.has(b.id) ? 1 : 0;
    return assignedB - assignedA || finiteStrength(b) - finiteStrength(a) || compareIds(a.id, b.id);
  });
  const selected: UnitState[] = [];
  let strength = 0;
  for (const unit of ordered) {
    if (selected.length >= desiredCount && strength >= requiredStrength) break;
    selected.push(unit); strength += finiteStrength(unit);
  }
  return selected;
}

function selectDistributedPositions(positions: FrontlineDefensivePosition[], count: number): FrontlineDefensivePosition[] {
  if (count <= 0) return [];
  if (count >= positions.length) {
    const selected = [...positions];
    const reinforcementOrder = [...positions].sort((a, b) => b.threat - a.threat || a.segmentIndex - b.segmentIndex);
    for (let index = positions.length; index < count; index += 1) {
      selected.push(reinforcementOrder[(index - positions.length) % reinforcementOrder.length]);
    }
    return selected;
  }
  const selected: FrontlineDefensivePosition[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i += 1) {
    const baseline = count === 1 ? Math.floor((positions.length - 1) / 2) : Math.round(i * (positions.length - 1) / (count - 1));
    let best = baseline;
    const localChoices = [baseline - 1, baseline, baseline + 1]
      .filter((index) => index >= 0 && index < positions.length && !used.has(index))
      .sort((a, b) => positions[b].threat - positions[a].threat ||
        Math.abs(a - baseline) - Math.abs(b - baseline) || a - b);
    if (localChoices.length > 0) {
      best = localChoices[0];
    } else {
      for (let radius = 2; radius < positions.length; radius += 1) {
        const choices = [baseline - radius, baseline + radius].filter((index) => index >= 0 && index < positions.length && !used.has(index));
        if (choices.length) { best = choices.sort((a, b) => a - b)[0]; break; }
      }
    }
    used.add(best); selected.push(positions[best]);
  }
  return selected.sort((a, b) => a.segmentIndex - b.segmentIndex);
}

function assignDefenders(world: WorldState, sectorId: SectorId, units: UnitState[], targets: FrontlineDefensivePosition[], previous: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>, next: Map<UnitId, FrontlineDefensiveAssignment>): void {
  const meso = getMesoById(world);
  const remaining = [...targets];
  let reusedAssignments = 0;
  let createdAssignments = 0;
  for (const unit of [...units].sort((a, b) => compareIds(a.id, b.id))) {
    const prior = previous.get(unit.id);
    let target = remaining.find((position) => position.id === prior?.defensivePositionId);
    if (!target) target = remaining.sort((a, b) => positionDistance(unit, a, meso) - positionDistance(unit, b, meso) || b.threat - a.threat || a.segmentIndex - b.segmentIndex)[0];
    if (!target) break;
    if (
      prior?.sectorId === sectorId &&
      prior.defensivePositionId === target.id &&
      prior.targetRegionId === target.friendlyRegionId
    ) {
      next.set(unit.id, prior);
      reusedAssignments += 1;
    } else {
      next.set(unit.id, {
        sectorId,
        defensivePositionId: target.id,
        targetRegionId: target.friendlyRegionId,
      });
      createdAssignments += 1;
    }
    remaining.splice(remaining.indexOf(target), 1);
  }
  world.instrumentation?.incrementCounter(
    "frontlineCoverage.assignmentReused",
    reusedAssignments,
  );
  world.instrumentation?.incrementCounter(
    "frontlineCoverage.assignmentCreated",
    createdAssignments,
  );
}

function coverageInputIsCurrent(
  state: FrontlineCoverageState,
  world: WorldState,
): boolean {
  return (
    state.sourceAllocationVersion !== world.frontAllocations.version ||
    state.sourceFrontVersion !== world.landFronts.version ||
    state.sourceOperationMembershipVersion !== world.offensiveOperations.membershipVersion ||
    state.sourceOperationVersion !== world.offensiveOperations.version ||
    state.sourceOccupationVersion !== world.occupation.version ||
    state.sourceBuildingVersion !== world.buildingVersion
  ) === false;
}

function evaluatePositions(world: WorldState, positions: FrontlineDefensivePosition[], units: UnitState[], assignments: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>, minimumStrength: number): void {
  const byId = new Map(positions.map((position) => [position.id, position]));
  for (const unit of units) {
    const assigned = assignments.get(unit.id);
    const position = assigned && byId.get(assigned.defensivePositionId);
    if (!position) continue;
    position.defenderUnitIds.push(unit.id);
    position.defenderStrength += finiteStrength(unit);
  }
  const required = positions.length ? minimumStrength / Math.min(positions.length, Math.max(1, units.length)) : 0;
  const settings = WORLD_BALANCE.war.landFront.frontlineCoverage;
  for (const position of positions) {
    position.requiredStrength = required;
    if (position.defenderStrength >= required * settings.coveredStrengthRatio && position.defenderStrength > 0) position.state = "covered";
    else if (position.defenderStrength >= required * settings.weakStrengthRatio && position.defenderStrength > 0) position.state = "weak";
  }
  for (const position of positions) {
    if (position.state !== "gap") continue;
    const nearby = positions.some((other) => other.defenderStrength > 0 && Math.abs(other.segmentIndex - position.segmentIndex) <= settings.nearbyCoverageDistance);
    if (nearby) position.state = "weak";
  }
  for (const position of positions) {
    if (position.state !== "gap") continue;
    const neighboringWeak = positions.filter((other) =>
      other.state !== "covered" && Math.abs(other.segmentIndex - position.segmentIndex) === 1,
    ).length;
    position.urgency = 1 + neighboringWeak * 2 + position.enemyRegionIds.length * 3 +
      position.threat * WORLD_BALANCE.war.landFront.frontlineCoverage.threatEnemyStrengthWeight;
  }
}

function gapLengths(positions: FrontlineDefensivePosition[]): number[] {
  const lengths: number[] = []; let current = 0;
  for (const position of positions) {
    if (position.state === "gap") current += 1;
    else if (current) { lengths.push(current); current = 0; }
  }
  if (current) lengths.push(current);
  return lengths;
}

function countBreakthroughs(
  world: WorldState,
  nationId: NationId,
  previous: SectorFrontlineCoverage | undefined,
): number {
  if (!previous) return 0;
  return previous.positions.filter(
    (position) =>
      position.state === "covered" &&
      world.occupation.mesoById.has(position.friendlyRegionId) &&
      world.occupation.mesoById.get(position.friendlyRegionId) !== nationId,
  ).length;
}

function countAssignmentChanges(before: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>, after: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>): number {
  let count = 0;
  for (const [unitId, assignment] of after) {
    const old = before.get(unitId);
    if (old && old.defensivePositionId !== assignment.defensivePositionId) count += 1;
  }
  return count;
}

function assignmentMapsEqual(
  before: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>,
  after: ReadonlyMap<UnitId, FrontlineDefensiveAssignment>,
): boolean {
  if (before.size !== after.size) return false;
  for (const [unitId, assignment] of before) {
    const next = after.get(unitId);
    if (!next || next.sectorId !== assignment.sectorId ||
      next.defensivePositionId !== assignment.defensivePositionId) return false;
  }
  return true;
}

function indexLandStrength(world: WorldState): Map<MesoRegionId, Map<NationId, number>> {
  const result = new Map<MesoRegionId, Map<NationId, number>>();
  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    let byNation = result.get(unit.regionId);
    if (!byNation) { byNation = new Map(); result.set(unit.regionId, byNation); }
    byNation.set(unit.nationId, (byNation.get(unit.nationId) ?? 0) + finiteStrength(unit));
  }
  return result;
}

function buildingThreat(region: MesoRegion | undefined): number {
  const settings = WORLD_BALANCE.war.landFront.frontlineCoverage;
  return region?.building === "capital" ? settings.capitalThreatBonus : region?.building === "city" ? settings.cityThreatBonus : 0;
}

function nearbyBuildingThreat(
  regionId: MesoRegionId,
  mesoById: ReadonlyMap<MesoRegionId, MesoRegion>,
  neighborsById: ReadonlyMap<MesoRegionId, readonly MesoRegionId[]>,
): number {
  let result = buildingThreat(mesoById.get(regionId));
  for (const neighborId of neighborsById.get(regionId) ?? []) {
    result = Math.max(result, buildingThreat(mesoById.get(neighborId)) * 0.75);
    for (const secondId of neighborsById.get(neighborId) ?? []) {
      result = Math.max(result, buildingThreat(mesoById.get(secondId)) * 0.5);
    }
  }
  return result;
}

function positionDistance(unit: UnitState, position: FrontlineDefensivePosition, meso: ReadonlyMap<MesoRegionId, MesoRegion>): number {
  const a = meso.get(unit.regionId)?.center; const b = meso.get(position.friendlyRegionId)?.center;
  if (!a || !b) return 0;
  const dx = a.x - b.x; const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function finiteStrength(unit: UnitState): number {
  const value = getUnitCombatStrength(unit);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function sumStrength(units: readonly UnitState[]): number { return units.reduce((sum, unit) => sum + finiteStrength(unit), 0); }
function key(sectorId: SectorId, nationId: NationId): string { return `${sectorId}::${nationId}`; }
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
