import { WORLD_BALANCE } from "../data/balance";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";

export type IsolationEffectStage = "supplied" | "isolated" | "strained";
export type IsolationAgeBucket = "0-100" | "100-200" | "200-500" | "500+";

export interface IsolationAgeBucketMetrics {
  unitCount: number;
  organizationTotal: number;
}

export interface IsolationEffectsState {
  version: number;
  isolatedUnitsEvaluated: number;
  unitsInGracePeriod: number;
  strainedUnits: number;
  organizationDecayApplications: number;
  totalOrganizationLost: number;
  unitsHittingFloor: number;
  isolationAgeAtFloorTicks: number;
  currentIsolatedUnitCount: number;
  currentGraceUnitCount: number;
  currentStrainedUnitCount: number;
  currentAverageIsolatedOrganization: number;
  currentHighOrganizationIsolatedUnits: number;
  organizationByAgeBucket: Record<IsolationAgeBucket, IsolationAgeBucketMetrics>;
  reconnections: number;
  maritimeReconnections: number;
  decayStoppedByReconnection: number;
  // Diagnostic transition sets only; exposure age remains component-owned.
  previouslyIsolatedUnitIds: Set<UnitId>;
  previouslyDecayingUnitIds: Set<UnitId>;
}

export function createIsolationEffectsState(): IsolationEffectsState {
  return {
    version: 0,
    isolatedUnitsEvaluated: 0,
    unitsInGracePeriod: 0,
    strainedUnits: 0,
    organizationDecayApplications: 0,
    totalOrganizationLost: 0,
    unitsHittingFloor: 0,
    isolationAgeAtFloorTicks: 0,
    currentIsolatedUnitCount: 0,
    currentGraceUnitCount: 0,
    currentStrainedUnitCount: 0,
    currentAverageIsolatedOrganization: 0,
    currentHighOrganizationIsolatedUnits: 0,
    organizationByAgeBucket: createEmptyBuckets(),
    reconnections: 0,
    maritimeReconnections: 0,
    decayStoppedByReconnection: 0,
    previouslyIsolatedUnitIds: new Set(),
    previouslyDecayingUnitIds: new Set(),
  };
}

/** Applies organization-only isolation effects once per slow tick. */
export function updateIsolationEffects(world: WorldState): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.isolationEffects;
  const settings = WORLD_BALANCE.war.landFront.isolation;
  const isolatedNow = new Set<UnitId>();
  const decayingNow = new Set<UnitId>();
  const buckets = createEmptyBuckets();
  let isolatedCount = 0;
  let graceCount = 0;
  let strainedCount = 0;
  let isolatedOrganizationTotal = 0;
  let highOrganizationCount = 0;
  let supplyQueries = 0;

  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    supplyQueries += 1;
    const component = getUnitSupplyComponent(world, unit);
    if (!component || component.supplied) {
      if (state.previouslyIsolatedUnitIds.has(unit.id)) {
        state.reconnections += 1;
        world.instrumentation?.incrementCounter("isolationEffects.reconnections");
        if (component?.reason === "maritime-connected") {
          state.maritimeReconnections += 1;
          world.instrumentation?.incrementCounter("isolationEffects.maritimeReconnections");
        }
        if (state.previouslyDecayingUnitIds.has(unit.id)) {
          state.decayStoppedByReconnection += 1;
          world.instrumentation?.incrementCounter("isolationEffects.decayStoppedByReconnection");
        }
      }
      continue;
    }

    isolatedNow.add(unit.id);
    isolatedCount += 1;
    const age = getCurrentIsolationAge(world, component.isolatedSinceTick);
    const bucket = buckets[getIsolationAgeBucket(age)];
    bucket.unitCount += 1;

    if (age <= settings.graceTicks) {
      graceCount += 1;
    } else {
      strainedCount += 1;
      if (unit.org > settings.organizationFloor) {
        decayingNow.add(unit.id);
        const before = unit.org;
        unit.org = Math.max(
          settings.organizationFloor,
          unit.org - settings.organizationDecayPerSlowTick,
        );
        const lost = before - unit.org;
        if (lost > 0) {
          state.organizationDecayApplications += 1;
          state.totalOrganizationLost += lost;
          world.instrumentation?.incrementCounter("isolationEffects.decayApplications");
          world.instrumentation?.incrementCounter("isolationEffects.organizationLost", lost);
          if (unit.org === settings.organizationFloor) {
            state.unitsHittingFloor += 1;
            state.isolationAgeAtFloorTicks += age;
            world.instrumentation?.incrementCounter("isolationEffects.unitsHittingFloor");
            world.instrumentation?.incrementCounter("isolationEffects.ageAtFloorTicks", age);
          }
        }
      }
    }
    isolatedOrganizationTotal += unit.org;
    bucket.organizationTotal += unit.org;
    if (unit.org >= WORLD_BALANCE.war.landFront.reorganization.readyOrganizationRatio) {
      highOrganizationCount += 1;
    }
  }

  state.isolatedUnitsEvaluated += isolatedCount;
  state.unitsInGracePeriod += graceCount;
  state.strainedUnits += strainedCount;
  state.currentIsolatedUnitCount = isolatedCount;
  state.currentGraceUnitCount = graceCount;
  state.currentStrainedUnitCount = strainedCount;
  state.currentAverageIsolatedOrganization = isolatedCount > 0
    ? isolatedOrganizationTotal / isolatedCount
    : 0;
  state.currentHighOrganizationIsolatedUnits = highOrganizationCount;
  for (const bucketName of Object.keys(buckets) as IsolationAgeBucket[]) {
    state.organizationByAgeBucket[bucketName].unitCount +=
      buckets[bucketName].unitCount;
    state.organizationByAgeBucket[bucketName].organizationTotal +=
      buckets[bucketName].organizationTotal;
  }
  state.previouslyIsolatedUnitIds = isolatedNow;
  state.previouslyDecayingUnitIds = decayingNow;
  state.version += 1;

  world.instrumentation?.incrementCounter("isolationEffects.isolatedUnitsEvaluated", isolatedCount);
  world.instrumentation?.incrementCounter("isolationEffects.unitsInGrace", graceCount);
  world.instrumentation?.incrementCounter("isolationEffects.strainedUnits", strainedCount);
  world.instrumentation?.incrementCounter("isolationEffects.supplyQueries", supplyQueries);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "isolationEffects.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function getUnitIsolationEffect(
  world: WorldState,
  unit: UnitState,
): { stage: IsolationEffectStage; age: number; decayActive: boolean } {
  const component = getUnitSupplyComponent(world, unit);
  if (!component || component.supplied) {
    return { stage: "supplied", age: 0, decayActive: false };
  }
  const settings = WORLD_BALANCE.war.landFront.isolation;
  const age = getCurrentIsolationAge(world, component.isolatedSinceTick);
  const strained = age > settings.graceTicks;
  return {
    stage: strained ? "strained" : "isolated",
    age,
    decayActive: strained && unit.org > settings.organizationFloor,
  };
}

function getUnitSupplyComponent(world: WorldState, unit: UnitState) {
  const componentId = world.supplyAssessment.assessmentByNationId
    .get(unit.nationId)
    ?.componentIdByRegionId.get(unit.regionId);
  return componentId
    ? world.supplyAssessment.componentById.get(componentId)
    : undefined;
}

function getCurrentIsolationAge(
  world: WorldState,
  isolatedSinceTick: number | null,
): number {
  return isolatedSinceTick === null
    ? 0
    : Math.max(0, world.time.fastTick - isolatedSinceTick);
}

function getIsolationAgeBucket(age: number): IsolationAgeBucket {
  if (age <= 100) return "0-100";
  if (age <= 200) return "100-200";
  if (age <= 500) return "200-500";
  return "500+";
}

function createEmptyBuckets(): Record<IsolationAgeBucket, IsolationAgeBucketMetrics> {
  return {
    "0-100": { unitCount: 0, organizationTotal: 0 },
    "100-200": { unitCount: 0, organizationTotal: 0 },
    "200-500": { unitCount: 0, organizationTotal: 0 },
    "500+": { unitCount: 0, organizationTotal: 0 },
  };
}
