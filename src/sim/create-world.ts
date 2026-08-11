import type { WorldConfig } from "../data/world-config";
import { WORLD_BALANCE } from "../data/balance";
import { SeededRng } from "../utils/seeded-rng";
import { applyElevation } from "../worldgen/apply/elevation";
import { applyRivers } from "../worldgen/apply/rivers";
import { applySeaLevel } from "../worldgen/apply/sea-level";
import { createMicroRegionEdges } from "../worldgen/create-micro-region-edges";
import { generateMicroRegions } from "../worldgen/generate/micro-regions";
import { generateMesoRegions } from "../worldgen/generate/meso-regions";
import { generateNations } from "../worldgen/generate/nations";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { BattleState } from "./battles";
import { createInitialUnits } from "./create-units";
import {
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
} from "./nation-runtime";
import { createOccupationState } from "./occupation";
import { createLandFrontState } from "./land-fronts";
import { createNationFrontPlanState } from "./nation-front-plans";
import { createNationFrontAllocationState } from "./nation-front-allocations";
import { createOffensiveOperationState } from "./offensive-operations";
import { createRetreatPlanState } from "./retreat-plans";
import { createCapitalDefenseState } from "./capital-defense";
import { createStrategicReserveState } from "./strategic-reserves";
import { createReorganizationState } from "./reorganization";
import { createFrontlineCoverageState } from "./frontline-coverage";
import { createStalematePressureState } from "./stalemate-pressure";
import { createStrategicProgressState } from "./strategic-progress";
import { createCollapseAdvanceState } from "./collapse-advance";
import { createBattlefieldTopologyState } from "./battlefield-topology";
import { createSupplyAssessmentState } from "./supply-assessment";
import { createIsolationEffectsState } from "./isolation-effects";
import { nextScheduledTickRange } from "./schedule";
import { addTestWar } from "./test-war";
import { createSimTime } from "./time";
import type { UnitState } from "./unit";
import type { WarState } from "./war-state";
import type { WorldState } from "./world-state";
import { createWorldCache } from "./world-cache";
import { createProductionDiagnosticsState } from "./production";
import { createSupplyCutoffAnalysisState } from "./supply-cutoff";
import { createSupplyDefenseState } from "./supply-defense";
import { createSupplyReliefState } from "./supply-relief";
import { createAmphibiousOperationState } from "./amphibious";
import { createStrategicThreatObservationState } from "./strategic-threat-observation";
import { createWarIntentState } from "./war-intent";
import { createCommonThreatCoalitionState } from "./common-threat-coalitions";

export function createWorld(config: WorldConfig): WorldState {
  const rng = new SeededRng(config.seed);
  const simRng = new SeededRng(config.seed + 1);
  const microRegions = generateMicroRegions(config, rng);
  const microRegionEdges = createMicroRegionEdges(microRegions);
  applyElevation(microRegions, config, rng);
  applySeaLevel(microRegions, config);
  applyRivers(microRegions, microRegionEdges, rng, config.riverSourceCount);
  const mesoRegions = generateMesoRegions(microRegions, config, rng);
  const { macroRegions, nations } = generateNations(mesoRegions, config, rng);
  const productionBalance = WORLD_BALANCE.production;
  const unitRange = productionBalance.unitSlowTickRange;
  const isUnitProductionEnabled = unitRange.min > 0 && unitRange.max > 0;
  const declareBalance = WORLD_BALANCE.war.declare;
  const declareRange = declareBalance.slowTickRange;
  const isWarDeclarationEnabled = declareRange.min > 0 && declareRange.max > 0;
  const runtimeNations: NationRuntime[] = nations.map((nation) => ({
    ...nation,
    unitRoles: {
      defenseUnitIds: [],
      occupationUnitIds: [],
    },
    capitalFallCount: 0,
    surrenderScore: 0,
    initialUnitCount: 0,
    initialCityCount: 0,
    warCooperation: WORLD_BALANCE.war.cooperation.max,
    warCooperationBoost: 0,
    resources: createNationResources(),
    resourceFlow: createNationResourceFlow(),
    nextUnitProductionTick: isUnitProductionEnabled
      ? nextScheduledTickRange(0, unitRange.min, unitRange.max, simRng)
      : Number.POSITIVE_INFINITY,
    nextWarDeclarationTick: isWarDeclarationEnabled
      ? nextScheduledTickRange(0, declareRange.min, declareRange.max, simRng)
      : Number.POSITIVE_INFINITY,
  }));
  const initialCityCounts = collectCityCountsByNation(mesoRegions, macroRegions);
  for (const nation of runtimeNations) {
    nation.initialCityCount = initialCityCounts.get(nation.id) ?? 0;
  }

  const units = createInitialUnits(runtimeNations, simRng);
  const unitIdCounter = units.length;
  const initialUnitCounts = collectUnitCountsByNation(units);
  for (const nation of runtimeNations) {
    nation.initialUnitCount = initialUnitCounts.get(nation.id) ?? 0;
  }
  const time = createSimTime();
  const wars: WarState[] = [];
  // TODO: remove test war
  // addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  const battles: BattleState[] = [];
  const occupation = createOccupationState();
  const landFronts = createLandFrontState();
  const frontPlans = createNationFrontPlanState();
  const frontAllocations = createNationFrontAllocationState();
  const frontlineCoverage = createFrontlineCoverageState();
  const offensiveOperations = createOffensiveOperationState();
  const retreatPlans = createRetreatPlanState();
  const capitalDefense = createCapitalDefenseState();
  const strategicReserves = createStrategicReserveState();
  const reorganization = createReorganizationState();
  const strategicProgress = createStrategicProgressState();
  const strategicThreatObservation = createStrategicThreatObservationState();
  const warIntent = createWarIntentState();
  const commonThreatCoalitions = createCommonThreatCoalitionState();
  const stalematePressure = createStalematePressureState();
  const collapseAdvances = createCollapseAdvanceState();
  const battlefieldTopology = createBattlefieldTopologyState();
  const supplyAssessment = createSupplyAssessmentState();
  const isolationEffects = createIsolationEffectsState();
  const productionDiagnostics = createProductionDiagnosticsState(units);
  const supplyCutoffs = createSupplyCutoffAnalysisState();
  const supplyDefense = createSupplyDefenseState();
  const supplyRelief = createSupplyReliefState();
  const amphibiousOperations = createAmphibiousOperationState();
  const mapVersion = 0;
  const territoryVersion = 0;
  const buildingVersion = 0;
  const cache = createWorldCache();

  return {
    width: config.width,
    height: config.height,
    microRegions,
    microRegionEdges,
    mesoRegions,
    macroRegions,
    nations: runtimeNations,
    wars,
    battles,
    occupation,
    landFronts,
    frontPlans,
    frontAllocations,
    frontlineCoverage,
    offensiveOperations,
    retreatPlans,
    capitalDefense,
    strategicReserves,
    reorganization,
    strategicProgress,
    strategicThreatObservation,
    warIntent,
    commonThreatCoalitions,
    stalematePressure,
    collapseAdvances,
    battlefieldTopology,
    supplyAssessment,
    isolationEffects,
    productionDiagnostics,
    supplyCutoffs,
    supplyDefense,
    supplyRelief,
    amphibiousOperations,
    mapVersion,
    territoryVersion,
    buildingVersion,
    units,
    unitIdCounter,
    simRng,
    cache,
    time,
  };
}

function collectCityCountsByNation(
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
): Map<NationId, number> {
  const ownerByMesoId = new Map<MesoRegion["id"], NationId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }

  const counts = new Map<NationId, number>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    if (meso.building !== "city" && meso.building !== "capital") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  return counts;
}

function collectUnitCountsByNation(
  units: UnitState[],
): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
  return counts;
}
