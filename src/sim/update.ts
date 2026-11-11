import { updateWarCampaigns } from "./war-campaign/update";
import { updatePlayerNavalOrders } from "./player-naval-orders";
import { updateResourceReparations } from "./resource-reparations";
import { updateCrisisDeployments } from "./crisis-deployment";
import { updateForcedDisplacement } from "./forced-displacement";
import { updateReligiousPersecution } from "./religious-persecution";
import { updatePeaceConferences } from "./peace-conference";
import { updateFoodTrade } from "./food-trade";
import { updateFoodSupply } from "./food-supply";
import { updateBudgetPolicies } from "./budget-policy";
import { updatePublicWorks } from "./public-works";
import { updateMilitaryFunding } from "./military-funding";
import { updateTreasuries } from "./treasury";
import { updateSubjectAutonomy } from "./subject-autonomy";
import { updateAnnexations } from "./annexation";
import { updatePopulationPolitics } from "./population-politics";
import { updateNationalistMovements } from "./nationalist-movements";
import { updateBorderIncidents } from "./border-incidents";
import { updateFactionSanctions } from "./trade-embargo";
import { updateDefensePacts } from "./defense-pacts";
import { updateTerritorialGovernance } from "./territorial-governance";
import { updatePopulationMigration } from "./population-migration";
import { updateCoastalInvestment } from "./coastal-investment";
import { updateSubjectGovernments } from "./subject-governments";
import { updateForeignPoliticalInfluence } from "./political-influence";
import { updateNationalPolitics } from "./politics";
import { updateExileGovernments } from "./exile-government";
import { updateVolunteers } from "./volunteers";
import { updateAlliedWarRequests } from "./allied-war-requests";
import { updateMilitaryAccess } from "./military-access";
import { updateMobilization, updateDemobilization } from "./mobilization";
import { updateTerritorialDeals } from "./territorial-deals";
import { updateTerritorialClaims } from "./territorial-claims";
import { updateFactions, updateFactionWarCalls } from "./factions";
import { updateTechnologyExchange } from "./technology-exchange";
import { updateArmsAid } from "./arms-aid";
import { updateInternationalTrade } from "./international-trade";
import { updateEquipmentRefits } from "./equipment-development";
import { updateResearch } from "./research";
import { updateDiplomaticPeace } from "./diplomatic-peace";
import { updateDiplomaticCrises } from "./diplomatic-crises";
import { updateDiplomaticRelations } from "./diplomacy";
import { WORLD_BALANCE } from "../data/balance";
import type { WorldState } from "./world-state";
import { updateBattles } from "./battles";
import { updateCapitals } from "./capitals";
import { updateCivilWar } from "./civil-war";
import {
  updateAmphibiousCapabilityAssembly,
  updateAmphibiousOperations,
  updateAmphibiousPlanning,
} from "./amphibious";
import { repositionUnits } from "./nation/reposition-units";
import { updateOccupation } from "./occupation";
import { updateProduction } from "./production";
import { updateSurrender } from "./surrender";
import { updateWarCooperation } from "./war-cooperation";
import { updateWarDeclarations } from "./war-declaration";
import { updateLandFronts } from "./land-fronts";
import { updateNationFrontPlans } from "./nation-front-plans";
import { updateNationFrontAllocations } from "./nation-front-allocations";
import {
  cancelOffensiveOperationsForCapitalEmergency,
  updateOffensiveOperations,
} from "./offensive-operations";
import { updateRetreatPlans } from "./retreat-plans";
import { updateCapitalDefense } from "./capital-defense";
import { updateStrategicReserves } from "./strategic-reserves";
import { updateReorganization } from "./reorganization";
import { updateFrontlineCoverage } from "./frontline-coverage";
import { updateStalematePressure } from "./stalemate-pressure";
import { updateStrategicProgress } from "./strategic-progress";
import { updateStrategicThreatObservation } from "./strategic-threat-observation";
import { updateCommonThreatCoalitions } from "./common-threat-coalitions";
import { updateCollapseAdvances } from "./collapse-advance";
import { updateBattlefieldTopology } from "./battlefield-topology";
import { updateSupplyAssessment } from "./supply-assessment";
import { updateIsolationEffects } from "./isolation-effects";
import { updateMaritimeEscortMovement } from "./maritime-escort";
import { updateConvoyMovement } from "./convoy-system";
import {
  recordMaritimeInterdictionCombat,
  updateMaritimeInterdictionMovement,
} from "./maritime-interdiction";
import { updateNavalStrategyMovement } from "./naval-strategy";
import { updateSupplyCutoffAnalysis } from "./supply-cutoff";
import { updateSupplyDefense } from "./supply-defense";
import { updateSupplyRelief } from "./supply-relief";
import {
  beginAiGeographyEvaluation,
  prepareFrontDistanceFields,
} from "./ai-geography";
import {
  FAST_TICK_MS,
  SLOW_TICK_MS,
  getSpeedMultiplier,
  type SimClock,
} from "./time";

const MAX_FRAME_MS = 250;
const MAX_FAST_TICKS_PER_FRAME = 8;
const FAST_TICK_BUDGET_MS = 8;

export function updateSimulation(world: WorldState, clock: SimClock, deltaMs: number): void {
  if (clock.paused) return;
  const clampedDelta = Math.min(MAX_FRAME_MS, Math.max(0, deltaMs));
  const scaledMs = clampedDelta * getSpeedMultiplier(clock);
  if (scaledMs <= 0) {
    return;
  }

  clock.accumulatorMs += scaledMs;
  clock.slowAccumulatorMs += scaledMs;

  let processedFastTicks = 0;
  const fastTickBudgetStartedAt =
    clock.accumulatorMs >= FAST_TICK_MS ? performance.now() : 0;
  while (
    clock.accumulatorMs >= FAST_TICK_MS &&
    processedFastTicks < MAX_FAST_TICKS_PER_FRAME
  ) {
    clock.accumulatorMs -= FAST_TICK_MS;
    stepFastTick(world, FAST_TICK_MS);
    processedFastTicks += 1;
    if (performance.now() - fastTickBudgetStartedAt >= FAST_TICK_BUDGET_MS) {
      break;
    }
  }

  const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
  while (
    clock.slowAccumulatorMs >= SLOW_TICK_MS &&
    world.time.slowTick < dueSlowTicks
  ) {
    clock.slowAccumulatorMs -= SLOW_TICK_MS;
    stepSlowTick(world, SLOW_TICK_MS);
  }
}

export function stepFastTick(world: WorldState, dtMs: number): void {
  const instrumentation = world.instrumentation;
  const occupationVersionBefore = instrumentation
    ? world.occupation.version
    : 0;
  const territoryVersionBefore = instrumentation ? world.territoryVersion : 0;
  world.time.fastTick += 1;
  world.time.elapsedMs += dtMs;

  let startedAt = instrumentation ? performance.now() : 0;
  repositionUnits(world, dtMs);
  if (instrumentation) {
    instrumentation.recordDuration("repositionUnits", performance.now() - startedAt);
  }
  if (Boolean(WORLD_BALANCE.unit.naval?.amphibiousEnabled)) {
    updateAmphibiousCapabilityAssembly(world, dtMs);
    updateAmphibiousOperations(world);
  }
  updateMaritimeEscortMovement(world, dtMs);
  updateConvoyMovement(world, dtMs);
  updateMaritimeInterdictionMovement(world, dtMs);
  updateNavalStrategyMovement(world, dtMs);
  updatePlayerNavalOrders(world, dtMs);
  recordMaritimeInterdictionCombat(world);
  startedAt = instrumentation ? performance.now() : 0;
  updateBattles(world);
  recordMaritimeInterdictionCombat(world);
  if (instrumentation) {
    instrumentation.recordDuration("battle.update", performance.now() - startedAt);
  }

  startedAt = instrumentation ? performance.now() : 0;
  updateOccupation(world);
  if (instrumentation) {
    instrumentation.recordDuration("updateOccupation", performance.now() - startedAt);
    instrumentation.incrementCounter("occupation.fullRegionScans");
    instrumentation.incrementCounter(
      "occupation.regionsScanned",
      world.mesoRegions.length,
    );
  }

  startedAt = instrumentation ? performance.now() : 0;
  updateCapitals(world);
  if (instrumentation) {
    instrumentation.recordDuration("updateCapitals", performance.now() - startedAt);
  }
  updateWarCooperation(world);
  updateCivilWar(world);

  startedAt = instrumentation ? performance.now() : 0;
  updateSurrender(world);
  if (instrumentation) {
    instrumentation.recordDuration("surrender", performance.now() - startedAt);
    instrumentation.incrementCounter(
      "world.occupationChanges",
      world.occupation.version - occupationVersionBefore,
    );
    instrumentation.incrementCounter(
      "world.territoryChanges",
      world.territoryVersion - territoryVersionBefore,
    );
  }
}

export function stepSlowTick(world: WorldState, _dtMs: number): void {
  world.time.slowTick += 1;
  updateSubjectGovernments(world);
  updateExileGovernments(world);
  updateTerritorialClaims(world);
  updateForeignPoliticalInfluence(world);
  updateNationalPolitics(world);
  updateNationalistMovements(world);
  updateDiplomaticRelations(world);
  updateMilitaryAccess(world);
  updateFactions(world);
  updateDefensePacts(world);
  updateBorderIncidents(world);
  updateTerritorialDeals(world);
  updatePeaceConferences(world);
  updateDiplomaticPeace(world);
  updateDiplomaticCrises(world);
  updateFactionSanctions(world);
  updateFactionWarCalls(world);
  updateAlliedWarRequests(world);
  updateVolunteers(world);
  updateWarDeclarations(world);
  updateCrisisDeployments(world);
  updateBudgetPolicies(world);
  updateTreasuries(world);
  updateMilitaryFunding(world);
  updateMobilization(world);
  beginAiGeographyEvaluation(world);
  updateSupplyAssessment(world);
  updateAnnexations(world);
  updateTerritorialGovernance(world);
  updateProduction(world);
  updateResourceReparations(world);
  updateSubjectAutonomy(world);
  updateDemobilization(world);
  updateResearch(world);
  updateEquipmentRefits(world);
  updatePublicWorks(world);
  updateCoastalInvestment(world);
  updateFoodTrade(world);
  updateInternationalTrade(world);
  updatePopulationMigration(world);
  updateFoodSupply(world);
  updatePopulationPolitics(world);
  updateReligiousPersecution(world);
  updateForcedDisplacement(world);
  updateArmsAid(world);
  updateTechnologyExchange(world);
  updateIsolationEffects(world);
  updateLandFronts(world);
  prepareFrontDistanceFields(world);
  // One topology/cutoff pass is shared by both offensive targeting and the
  // defensive consumer below.  It deliberately precedes allocation.
  updateBattlefieldTopology(world);
  updateSupplyCutoffAnalysis(world);
  updateSupplyDefense(world);
  updateSupplyRelief(world);
  updateCapitalDefense(world);
  updateWarCampaigns(world);
  updateNationFrontPlans(world);
  updateRetreatPlans(world);
  cancelOffensiveOperationsForCapitalEmergency(world);
  updateStrategicReserves(world);
  updateReorganization(world);
  updateStrategicProgress(world);
  updateStalematePressure(world);
  updateNationFrontAllocations(world);
  updateFrontlineCoverage(world);
  updateOffensiveOperations(world);
  updateAmphibiousPlanning(world);
  updateCollapseAdvances(world);
  // Phase A observer runs after all strategic producers and has no consumers.
  updateStrategicThreatObservation(world);
  updateCommonThreatCoalitions(world);
}
