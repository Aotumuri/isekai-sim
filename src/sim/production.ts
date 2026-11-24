import { getOperatingOccupiedDeposits } from "./occupied-deposits";
import { isStrategicResource, STRATEGIC_RESOURCES, type StrategicResource } from "../data/strategic-resources";
import { isMilitaryFunded } from "./military-funding";
import { annexedOutputFactor } from "./annexation";
import { industrialRecoveryFactor } from "./industrial-recovery";
import { allMobilizedUnits, getArmyLimits, getMobilization } from "./mobilization";
import { equipNewUnit, getDevelopedUnitWeaponCost } from "./equipment-development";
import { getNationalDesign, type WeaponDesign } from "./research";
import { getCampaignRecoveryStock, campaignProductionResources } from "./war-campaign/production-budget";
import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { createUnitForType } from "./create-units";
import { getAmphibiousNavalProductionDemands } from "./amphibious";
import { isNationActive } from "./nation-active";
import { getManualGovernmentId } from "./player-nation";
import { allocateFuelUpkeep, collectFuelUpkeep, getUnitFuelUse, type UpkeepRequest } from "./fuel-upkeep";
import { fuelForPrototypes, steelForResearch, weaponReserve } from "./resource-planning";
import type { NationResourceFlow, NationResources } from "./nation-runtime";
import { nextScheduledTickRange } from "./schedule";
import { daysToSlowTicks } from "./time";
import { registerNewCombatShipsAsReserve, type DesiredNavalForce } from "./naval-strategy";
import {
  isNationRegionSupplied,
  type SupplyComponentId,
} from "./supply-assessment";
import { createUnitId, type NavalUnitType, type UnitState, type UnitType } from "./unit";
import type { WorldState } from "./world-state";
import { buildWarAdjacency } from "./war-state";
import { getCityTargetsByNation, getOwnerByMesoId, getPortTargetsByNation } from "./world-cache";

const MOBILIZED_MIN_INTERVAL = daysToSlowTicks(20);
const WARTIME_MAX_INTERVAL = daysToSlowTicks(60);
const ALERT_MAX_INTERVAL = daysToSlowTicks(120);

export type ProductionSupplyStatus = "supplied" | "blocked-isolation";

export interface ProductionLocationDiagnostic {
  nationId: NationId;
  regionId: MesoRegionId;
  supplyStatus: ProductionSupplyStatus;
  componentId: SupplyComponentId | null;
  evaluatedAtSlowTick: number;
}

export interface ProductionDiagnosticsState {
  currentLandUnits: number;
  currentNavalUnits: number;
  peakLandUnits: number;
  peakNavalUnits: number;
  landProductionBlockedByCapacity: number;
  navalProductionBlockedByCapacity: number;
  attemptedProductions: number;
  blockedProductions: number;
  blockedByIsolation: number;
  blockedByNoManpower: number;
  blockedByEconomy: number;
  successfulProductions: number;
  supplyLookups: number;
  navalTransportRequests: number;
  navalEscortRequests: number;
  navalReserveRequests: number;
  navalTransportFulfilled: number;
  navalEscortFulfilled: number;
  navalReserveFulfilled: number;
  navalCombatRequestsByReason: Record<CombatShipProductionReason, number>;
  navalCombatFulfilledByReason: Record<CombatShipProductionReason, number>;
  navalCombatObsoleteRequests: number;
  navalCombatWeaponsCost: number;
  navalCombatManpowerCost: number;
  blockedByComponentId: Map<string, number>;
  locationByRegionId: Map<MesoRegionId, ProductionLocationDiagnostic>;
  version: number;
}

export type CombatShipProductionReason =
  | "baseline-fleet"
  | "offensive-bootstrap"
  | "naval-threat"
  | "escort-deficit"
  | "amphibious-capability"
  | "reserve-restoration";

function emptyCombatShipReasonCounts(): Record<CombatShipProductionReason, number> {
  return { "baseline-fleet": 0, "offensive-bootstrap": 0, "naval-threat": 0,
    "escort-deficit": 0, "amphibious-capability": 0, "reserve-restoration": 0 };
}

function selectCombatShipProductionReason(
  force: DesiredNavalForce,
): CombatShipProductionReason | undefined {
  if (force.deficit <= 0) return undefined;
  if (force.currentCombatShips === 0 && force.offensiveOpportunityDemand > 0) {
    return "offensive-bootstrap";
  }
  if (force.currentCombatShips === 0 && force.enemyNavalThreatDemand > 0) {
    return "naval-threat";
  }
  if (force.currentCombatShips < force.escortDemand) return "escort-deficit";
  if (force.currentCombatShips < force.baselineCombatShips + force.escortDemand) {
    return "baseline-fleet";
  }
  const threatCeiling = force.baselineCombatShips + force.escortDemand +
    Math.max(force.interceptionDemand, force.enemyNavalThreatDemand);
  if (force.currentCombatShips < threatCeiling) return "naval-threat";
  if (force.currentCombatShips < threatCeiling + force.offensiveOpportunityDemand) {
    return "offensive-bootstrap";
  }
  return force.reserveTarget > 0 ? "reserve-restoration" : "baseline-fleet";
}

export function createProductionDiagnosticsState(
  units: readonly UnitState[] = [],
): ProductionDiagnosticsState {
  let currentLandUnits = 0;
  let currentNavalUnits = 0;
  for (const unit of units) {
    if (unit.domain === "naval") currentNavalUnits += 1;
    else currentLandUnits += 1;
  }
  return {
    currentLandUnits,
    currentNavalUnits,
    peakLandUnits: currentLandUnits,
    peakNavalUnits: currentNavalUnits,
    landProductionBlockedByCapacity: 0,
    navalProductionBlockedByCapacity: 0,
    attemptedProductions: 0,
    blockedProductions: 0,
    blockedByIsolation: 0,
    blockedByNoManpower: 0,
    blockedByEconomy: 0,
    successfulProductions: 0,
    supplyLookups: 0,
    navalTransportRequests: 0,
    navalEscortRequests: 0,
    navalReserveRequests: 0,
    navalTransportFulfilled: 0,
    navalEscortFulfilled: 0,
    navalReserveFulfilled: 0,
    navalCombatRequestsByReason: emptyCombatShipReasonCounts(),
    navalCombatFulfilledByReason: emptyCombatShipReasonCounts(),
    navalCombatObsoleteRequests: 0,
    navalCombatWeaponsCost: 0,
    navalCombatManpowerCost: 0,
    blockedByComponentId: new Map(),
    locationByRegionId: new Map(),
    version: 0,
  };
}

export function updateProduction(world: WorldState): boolean {
  if (world.lastProductionSlowTick === world.time.slowTick) return false;
  world.lastProductionSlowTick = world.time.slowTick;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const transportAvailabilityChanged = updateProductionInternal(world);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "production.evaluation",
      performance.now() - startedAt,
    );
  }
  return transportAvailabilityChanged;
}

function updateProductionInternal(world: WorldState): boolean {
  if (world.nations.length === 0) {
    return false;
  }

  const previousResources = new Map<NationId, NationResources>();
  const flowByNation = new Map<NationId, NationResourceFlow>();
  for (const nation of world.nations) {
    if (!isNationActive(nation)) {
      continue;
    }
    previousResources.set(nation.id, cloneResources(nation.resources));
    flowByNation.set(nation.id, createEmptyFlow());
  }

  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  const resourceOutputs = collectResourceOutputs(
    world,
    world.mesoRegions,
    ownerByMesoId,
    occupationByMesoId,
  );
  if (world.mesoRegions.some((region) => isStrategicResource(region.resource))) {
    for (const nation of world.nations) {
      for (const resource of STRATEGIC_RESOURCES) nation.resources[resource] ??= 0;
    }
  }
  const fuelUpkeep = collectFuelUpkeep(world.units, flowByNation);
  const planning = !!world.settings && world.settings.economicPlanningEnabled !== false;
  const wars = planning ? buildWarAdjacency(world.wars) : undefined;
  const manualGovernment = planning ? getManualGovernmentId(world) : undefined;
  const mobilized = allMobilizedUnits(world);
  const unitCountsByNation = collectUnitCountsByNation(mobilized);
  let transportAvailabilityChanged = applyResourceOutputs(
    world.nations,
    resourceOutputs,
    fuelUpkeep,
    flowByNation,
    world,
    unitCountsByNation,
    wars,
    manualGovernment,
  );

  const production = WORLD_BALANCE.production;
  const unitRange = production.unitSlowTickRange;
  if (unitRange.min <= 0 || unitRange.max <= 0) {
    finalizeResourceFlows(world, flowByNation, previousResources);
    return transportAvailabilityChanged;
  }
  const minInterval = unitRange.min;
  const maxInterval = unitRange.max;
  const occupiedMacroById = world.occupation.macroById;
  const cityTargetsByNation = getCityTargetsByNation(world);
  const portTargetsByNation = getPortTargetsByNation(world);
  const capacityCountStartedAt = world.instrumentation ? performance.now() : 0;
  updateCapacityDiagnostics(world, unitCountsByNation, mobilized);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "production.capacityCounting",
      performance.now() - capacityCountStartedAt,
    );
  }

  const newUnits: UnitState[] = [];
  const cityUnitsPerCycle = Math.max(0, Math.round(production.cityUnitsPerCycle));
  const logisticsTransportDemandByNation = new Map<NationId, number>();
  for (const link of world.supplyAssessment.maritimeLinks) {
    if (link.reason !== "no-transport") continue;
    logisticsTransportDemandByNation.set(
      link.nationId,
      (logisticsTransportDemandByNation.get(link.nationId) ?? 0) +
        Math.max(0, link.requiredTransportCount - link.assignedTransportIds.length),
    );
  }
  const amphibiousTransportDemandByNation = new Map<NationId, number>();
  const amphibiousEscortDemandByNation = new Map<NationId, number>();
  const preferredAmphibiousPortByNation = new Map<NationId, MesoRegionId>();
  const amphibiousDemands = getAmphibiousNavalProductionDemands(world);
  for (const demand of amphibiousDemands) {
    amphibiousTransportDemandByNation.set(
      demand.nationId,
      (amphibiousTransportDemandByNation.get(demand.nationId) ?? 0) + demand.transports,
    );
    amphibiousEscortDemandByNation.set(
      demand.nationId,
      (amphibiousEscortDemandByNation.get(demand.nationId) ?? 0) + demand.escorts,
    );
    if ((demand.transports > 0 || demand.escorts > 0) &&
      !preferredAmphibiousPortByNation.has(demand.nationId)) {
      preferredAmphibiousPortByNation.set(demand.nationId, demand.departurePortId);
    }
  }
  const combatShipReasonsByNation = new Map<NationId, CombatShipProductionReason[]>();
  for (const assessment of world.supplyAssessment.navalStrategy.assessments) {
    const force = assessment.desiredForce;
    const reasons: CombatShipProductionReason[] = [];
    for (let index = 0; index < force.deficit; index += 1) {
      const reason = selectCombatShipProductionReason({
        ...force,
        currentCombatShips: force.currentCombatShips + index,
        deficit: force.deficit - index,
      });
      if (reason) reasons.push(reason);
    }
    combatShipReasonsByNation.set(force.nationId, reasons);
  }
  for (const [nationId, escortCount] of amphibiousEscortDemandByNation) {
    const reasons = combatShipReasonsByNation.get(nationId) ?? [];
    for (let index = 0; index < escortCount; index += 1) reasons.push("amphibious-capability");
    combatShipReasonsByNation.set(nationId, reasons);
  }
  const portNavalUnitsPerCycle = Math.max(
    0,
    Math.round(production.portNavalUnitsPerCycle ?? 0),
  );
  const maxLandUnits = Math.max(0, Math.round(production.maxLandUnits));
  const maxNavalUnits = Math.max(0, Math.round(production.maxNavalUnits));
  const legacyLandCapacity = maxLandUnits > 0 ? maxLandUnits : Number.POSITIVE_INFINITY;
  const navalCapacity = maxNavalUnits > 0 ? maxNavalUnits : Number.POSITIVE_INFINITY;

  for (const nation of world.nations) {
    if (!isNationActive(nation)) {
      continue;
    }
    if (world.time.slowTick < nation.nextUnitProductionTick) {
      continue;
    }
    const mobilization = world.settings?.mobilizationEnabled ? getMobilization(world, nation.id) : undefined;
    const landCapacity = mobilization ? getArmyLimits(world, nation, mobilization).authorized : legacyLandCapacity;
    const recruitmentBatch = mobilization ? Math.max(1, Math.ceil(landCapacity * 0.035)) : Number.POSITIVE_INFINITY;
    let recruited = 0;
    const designs = { Infantry: getNationalDesign(world, nation.id, "Infantry"), Tank: getNationalDesign(world, nation.id, "Tank"),
      CombatShip: getNationalDesign(world, nation.id, "CombatShip"), TransportShip: getNationalDesign(world, nation.id, "TransportShip") };
    const industry = flowByNation.get(nation.id)?.industry;
    const forecastTankFuel = industry && nation.id !== manualGovernment && !wars?.has(nation.id) && (mobilization?.threat ?? 0) < 0.35;
    const tankFuel = forecastTankFuel ? getUnitFuelUse("Tank") * designs.Tank.fuelUse : 0;
    let remainingTankFuel = industry
      ? industry.output.fuel - industry.fuelDemand + Math.max(0, nation.resources.fuel - industry.prototypeFuelReserve) / 5 : 0;
    const currentCounts = unitCountsByNation.get(nation.id) ?? { land: 0, naval: 0 };
    let currentLandCount = currentCounts.land;
    let currentNavalCount = currentCounts.naval;
    let recordedLandCapacityBlock = false;
    let recordedNavalCapacityBlock = false;
    const recordCapacityBlock = (domain: "land" | "naval"): void => {
      if (domain === "land") {
        if (recordedLandCapacityBlock) return;
        recordedLandCapacityBlock = true;
        world.productionDiagnostics.landProductionBlockedByCapacity += 1;
        world.instrumentation?.incrementCounter("production.blocked.capacity.land");
      } else {
        if (recordedNavalCapacityBlock) return;
        recordedNavalCapacityBlock = true;
        world.productionDiagnostics.navalProductionBlockedByCapacity += 1;
        world.instrumentation?.incrementCounter("production.blocked.capacity.naval");
      }
      world.productionDiagnostics.version += 1;
    };
    const amphibiousTransports = amphibiousTransportDemandByNation.get(nation.id) ?? 0;
    const recoveryStock = getCampaignRecoveryStock(world, nation.id);
    const amphibiousEscorts = amphibiousEscortDemandByNation.get(nation.id) ?? 0;
    const requestedTransports = (logisticsTransportDemandByNation.get(nation.id) ?? 0) +
      amphibiousTransports;
    const combatShipReasons = combatShipReasonsByNation.get(nation.id) ?? [];
    const requestedEscorts = combatShipReasons.filter((reason) => reason === "escort-deficit").length;
    const requestedReserves = combatShipReasons.filter((reason) => reason === "reserve-restoration").length;
    world.productionDiagnostics.navalTransportRequests += requestedTransports;
    world.productionDiagnostics.navalEscortRequests += requestedEscorts;
    world.productionDiagnostics.navalReserveRequests += requestedReserves;
    const capabilityRequests = amphibiousTransports + amphibiousEscorts;
    world.amphibiousOperations.capabilityProductionRequests += capabilityRequests;
    world.amphibiousOperations.capabilityTransportDemand += amphibiousTransports;
    world.amphibiousOperations.capabilityEscortDemand += amphibiousEscorts;
    world.instrumentation?.incrementCounter("production.naval.requests.transport", requestedTransports);
    world.instrumentation?.incrementCounter("production.naval.requests.escort", requestedEscorts);
    world.instrumentation?.incrementCounter("production.naval.requests.reserve", requestedReserves);
    for (const reason of combatShipReasons) recordCombatShipRequest(world, reason);

    const addUnit = (regionId: MesoRegionId, facility: "capital" | "city"): boolean => {
      if (recruited >= recruitmentBatch) return false;
      if (currentLandCount >= landCapacity) {
        recordCapacityBlock("land");
        return false;
      }
      const diagnostics = world.productionDiagnostics;
      diagnostics.attemptedProductions += 1;
      world.instrumentation?.incrementCounter("production.attempted");
      const supplyStartedAt = world.instrumentation ? performance.now() : 0;
      const supplied = isNationRegionSupplied(world, nation.id, regionId);
      diagnostics.supplyLookups += 1;
      world.instrumentation?.incrementCounter("production.supplyLookups");
      if (world.instrumentation) {
        world.instrumentation.recordDuration(
          "production.supplyLookup",
          performance.now() - supplyStartedAt,
        );
      }
      const componentId = world.supplyAssessment.assessmentByNationId
        .get(nation.id)
        ?.componentIdByRegionId.get(regionId) ?? null;
      diagnostics.locationByRegionId.set(regionId, {
        nationId: nation.id,
        regionId,
        supplyStatus: supplied ? "supplied" : "blocked-isolation",
        componentId,
        evaluatedAtSlowTick: world.time.slowTick,
      });
      diagnostics.version += 1;
      if (!supplied) {
        diagnostics.blockedProductions += 1;
        diagnostics.blockedByIsolation += 1;
        const componentKey = componentId ?? "none";
        diagnostics.blockedByComponentId.set(
          componentKey,
          (diagnostics.blockedByComponentId.get(componentKey) ?? 0) + 1,
        );
        world.instrumentation?.incrementCounter("production.blocked");
        world.instrumentation?.incrementCounter("production.blocked.isolation");
        if (world.instrumentation) {
          world.instrumentation.recordDuration(
            "production.supplyIntegration",
            performance.now() - supplyStartedAt,
          );
        }
        return false;
      }
      if (world.instrumentation) {
        world.instrumentation.recordDuration(
          "production.supplyIntegration",
          performance.now() - supplyStartedAt,
        );
      }
      const unitType = pickAffordableUnitType(campaignProductionResources(nation.resources, recoveryStock), world.simRng, designs,
        !forecastTankFuel || remainingTankFuel >= tankFuel);
      if (!unitType) {
        recordResourceBlock(world, nation.resources);
        return false;
      }
      const flow = flowByNation.get(nation.id);
      if (!consumeResourcesForUnit(nation.resources, unitType, flow?.usage, designs[unitType])) {
        recordResourceBlock(world, nation.resources);
        return false;
      }
      if (unitType === "Tank") remainingTankFuel -= tankFuel;
      const unit = createUnitForWorld(world, nation.id, regionId, unitType, designs[unitType]);
      newUnits.push(unit);
      world.instrumentation?.recordLandUnitLifecycle?.({
        tick: world.time.fastTick, unitId: unit.id, nationId: nation.id, regionId,
        reason: "production", facility, mobilizationPhase: mobilization?.phase ?? null,
      });
      currentLandCount += 1; recruited++;
      if (mobilization) mobilization.recruited++;
      diagnostics.successfulProductions += 1;
      world.instrumentation?.incrementCounter("production.successful");
      return true;
    };

    const addNavalUnit = (
      regionId: MesoRegionId,
      forcedType: NavalUnitType,
      reason: "transport" | CombatShipProductionReason,
    ): boolean => {
      if (currentNavalCount >= navalCapacity) {
        recordCapacityBlock("naval");
        return false;
      }
      const diagnostics = world.productionDiagnostics;
      diagnostics.attemptedProductions += 1;
      world.instrumentation?.incrementCounter("production.attempted");
      const unitType = pickNavalUnitType(campaignProductionResources(nation.resources, recoveryStock), forcedType, designs[forcedType]);
      if (!unitType) {
        recordResourceBlock(world, nation.resources, "naval");
        return false;
      }
      const flow = flowByNation.get(nation.id);
      if (!consumeResourcesForUnit(nation.resources, unitType, flow?.usage, designs[unitType])) {
        recordResourceBlock(world, nation.resources, "naval");
        return false;
      }
      newUnits.push(createUnitForWorld(world, nation.id, regionId, unitType, designs[unitType]));
      currentNavalCount += 1;
      diagnostics.successfulProductions += 1;
      world.instrumentation?.incrementCounter("production.successful");
      if (reason === "transport") {
        diagnostics.navalTransportFulfilled += 1;
        world.instrumentation?.incrementCounter("production.naval.fulfilled.transport");
      } else if (reason === "escort-deficit" || reason === "amphibious-capability") {
        diagnostics.navalEscortFulfilled += 1;
        if (reason === "escort-deficit") {
          world.supplyAssessment.maritimeEscorts.combatShipsProducedForEscortDemand += 1;
          world.instrumentation?.incrementCounter("maritimeEscort.production.combatShips");
        }
        world.instrumentation?.incrementCounter("production.naval.fulfilled.escort");
      } else {
        if (reason === "reserve-restoration") {
          diagnostics.navalReserveFulfilled += 1;
          world.instrumentation?.incrementCounter("production.naval.fulfilled.reserve");
        }
      }
      if (reason !== "transport") recordCombatShipFulfilled(world, reason, getDevelopedUnitWeaponCost(unitType, designs[unitType]));
      return true;
    };

    const capitalId = nation.capitalMesoId;
    if (
      isOwnedAndUnoccupied(capitalId, nation.id, ownerByMesoId, occupationByMesoId)
    ) {
      const ownedMacroCount = countOwnedMacroRegions(
        nation.id,
        world.macroRegions,
        occupiedMacroById,
      );
      const capitalUnits = Math.max(
        0,
        Math.round(ownedMacroCount * production.capitalUnitsPerOwnedMacro),
      );
      for (let i = 0; i < capitalUnits; i += 1) {
        if (!addUnit(capitalId, "capital")) {
          break;
        }
      }
    }

    const cityTargets = cityTargetsByNation.get(nation.id) ?? [];
    if (cityUnitsPerCycle > 0) {
      for (const cityId of cityTargets) {
        for (let i = 0; i < cityUnitsPerCycle; i += 1) {
          if (!addUnit(cityId, "city")) {
            break;
          }
        }
        if (currentLandCount >= landCapacity) {
          break;
        }
      }
    }

    const preferredAmphibiousPort = preferredAmphibiousPortByNation.get(nation.id) ?? null;
    const portTargets = [...(portTargetsByNation.get(nation.id) ?? [])].sort((a, b) =>
      (a === preferredAmphibiousPort ? -1 : b === preferredAmphibiousPort ? 1 : 0) ||
      (a < b ? -1 : a > b ? 1 : 0));
    if (
      (requestedTransports > 0 || combatShipReasons.length > 0) &&
      portNavalUnitsPerCycle > 0 &&
      portTargets.length > 0
    ) {
      let logisticsRemaining = requestedTransports;
      const combatReasonsRemaining = [...combatShipReasons];
      for (const portId of portTargets) {
        for (let i = 0; i < portNavalUnitsPerCycle; i += 1) {
          if (logisticsRemaining <= 0 && combatReasonsRemaining.length === 0) break;
          const reason = logisticsRemaining > 0
            ? "transport" as const
            : combatReasonsRemaining[0]!;
          const forcedType: NavalUnitType = reason === "transport" ? "TransportShip" : "CombatShip";
          if (!addNavalUnit(portId, forcedType, reason)) {
            break;
          }
          if (reason === "transport") logisticsRemaining -= 1;
          if (reason !== "transport") combatReasonsRemaining.shift();
        }
        if (currentNavalCount >= navalCapacity) {
          break;
        }
      }
    }

    unitCountsByNation.set(nation.id, {
      land: currentLandCount,
      naval: currentNavalCount,
    });
    const recruitmentInterval = isMilitaryFunded(world, nation.treasury) ? 0.6 : 1;
    const mobilizing = mobilization && mobilization.threat >= 0.35;
    const earliest = mobilizing ? MOBILIZED_MIN_INTERVAL : minInterval;
    const latest = !mobilizing ? maxInterval : mobilization.phase === "war" ? WARTIME_MAX_INTERVAL : ALERT_MAX_INTERVAL;
    nation.nextUnitProductionTick = nextScheduledTickRange(
      world.time.slowTick,
      Math.max(1, Math.ceil(earliest * recruitmentInterval)),
      Math.max(1, Math.ceil(latest * recruitmentInterval)),
      world.simRng,
    );
  }

  if (newUnits.length > 0) {
    const newUpkeep = collectFuelUpkeep(newUnits, flowByNation);
    for (const nation of world.nations) {
      const requests = newUpkeep.get(nation.id);
      if (requests) settleFuelUpkeep(nation.resources, flowByNation.get(nation.id)!, requests);
    }
    if (newUnits.some((unit) => unit.type === "TransportShip" && Number.isFinite(unit.moveTicksPerRegion))) {
      transportAvailabilityChanged = true;
    }
    world.units.push(...newUnits);
    registerNewCombatShipsAsReserve(world, newUnits);
    updateCapacityDiagnostics(world, unitCountsByNation, mobilized);
  }
  finalizeResourceFlows(world, flowByNation, previousResources);
  return transportAvailabilityChanged;
}

function recordResourceBlock(
  world: WorldState,
  resources: NationResources,
  domain: "land" | "naval" = "land",
): void {
  const diagnostics = world.productionDiagnostics;
  diagnostics.blockedProductions += 1;
  world.instrumentation?.incrementCounter("production.blocked");
  const minimumManpower = domain === "land"
    ? Math.min(getUnitManpowerCost("Infantry"), getUnitManpowerCost("Tank"))
    : Math.min(
        getUnitManpowerCost("TransportShip"),
        getUnitManpowerCost("CombatShip"),
      );
  if (resources.manpower < minimumManpower) {
    diagnostics.blockedByNoManpower += 1;
    world.instrumentation?.incrementCounter("production.blocked.noManpower");
    return;
  }
  diagnostics.blockedByEconomy += 1;
  world.instrumentation?.incrementCounter("production.blocked.economy");
}

function reasonCounterSuffix(reason: CombatShipProductionReason):
  "baseline" | "offensiveBootstrap" | "threat" | "escort" | "amphibiousCapability" | "reserveRestoration" {
  if (reason === "baseline-fleet") return "baseline";
  if (reason === "offensive-bootstrap") return "offensiveBootstrap";
  if (reason === "naval-threat") return "threat";
  if (reason === "escort-deficit") return "escort";
  if (reason === "amphibious-capability") return "amphibiousCapability";
  return "reserveRestoration";
}

function recordCombatShipRequest(world: WorldState, reason: CombatShipProductionReason): void {
  world.productionDiagnostics.navalCombatRequestsByReason[reason] += 1;
  if (reason !== "escort-deficit") {
    world.instrumentation?.incrementCounter(`production.naval.requests.${reasonCounterSuffix(reason)}`);
  }
}

function recordCombatShipFulfilled(world: WorldState, reason: CombatShipProductionReason, weaponCost: number): void {
  const diagnostics = world.productionDiagnostics;
  diagnostics.navalCombatFulfilledByReason[reason] += 1;
  diagnostics.navalCombatWeaponsCost += weaponCost;
  diagnostics.navalCombatManpowerCost += getUnitManpowerCost("CombatShip");
  if (reason !== "escort-deficit") {
    world.instrumentation?.incrementCounter(`production.naval.fulfilled.${reasonCounterSuffix(reason)}`);
  }
}

function createUnitForWorld(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  unitType: UnitType,
  design: WeaponDesign,
): UnitState {
  const unitId = createUnitId(world.unitIdCounter);
  world.unitIdCounter += 1;
  return equipNewUnit(world, createUnitForType(unitId, nationId, regionId, unitType), design);
}

function createEmptyFlow(): NationResourceFlow {
  return {
    income: createZeroResources(),
    usage: createZeroResources(),
    delta: createZeroResources(),
    lastTick: -1,
  };
}

function createZeroResources(): NationResources {
  return { steel: 0, fuel: 0, manpower: 0, weapons: 0 };
}

function cloneResources(resources: NationResources): NationResources {
  return {
    ...resources,
  };
}

function getFlow(
  flowByNation: Map<NationId, NationResourceFlow>,
  nationId: NationId,
): NationResourceFlow {
  const existing = flowByNation.get(nationId);
  if (existing) {
    return existing;
  }
  const created = createEmptyFlow();
  flowByNation.set(nationId, created);
  return created;
}

function finalizeResourceFlows(
  world: WorldState,
  flowByNation: Map<NationId, NationResourceFlow>,
  previousResources: Map<NationId, NationResources>,
): void {
  for (const nation of world.nations) {
    if (!isNationActive(nation)) {
      continue;
    }
    const flow = getFlow(flowByNation, nation.id);
    const previous = previousResources.get(nation.id);
    if (previous) {
      flow.delta = {
        steel: nation.resources.steel - previous.steel,
        fuel: nation.resources.fuel - previous.fuel,
        manpower: nation.resources.manpower - previous.manpower,
        weapons: nation.resources.weapons - previous.weapons,
      };
    } else {
      flow.delta = cloneResources(nation.resources);
    }
    if (flow.industry) {
      const recruitment = flow.usage.weapons;
      flow.industry.weaponsForRecruitment = recruitment;
      flow.industry.weaponDemandAverage += (recruitment - flow.industry.weaponDemandAverage) / 12;
    }
    flow.productionSurplus = {
      steel: Math.max(0, flow.income.steel - flow.usage.steel),
      fuel: Math.max(0, flow.income.fuel - (flow.industry?.fuelDemand ?? flow.fuelUpkeepDemand ?? 0)),
    };
    for (const resource of STRATEGIC_RESOURCES) {
      if (nation.resources[resource] !== undefined) {
        flow.productionSurplus[resource] = Math.max(0, (flow.income[resource] ?? 0) - (flow.usage[resource] ?? 0));
        flow.delta[resource] = (nation.resources[resource] ?? 0) - (previous?.[resource] ?? 0);
      }
    }
    flow.lastTick = world.time.slowTick;
    nation.resourceFlow = flow;
  }
}

interface ResourceOutput extends Partial<Record<StrategicResource, number>> {
  steel: number;
  fuel: number;
  manpower: number;
  weaponCapacity: number;
}

function collectResourceOutputs(
  world: WorldState,
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, ResourceOutput> {
  const outputBalance = WORLD_BALANCE.resources.output;
  const steelPerDeposit = Math.max(0, Math.round(outputBalance.steelPerDeposit));
  const fuelPerDeposit = Math.max(0, Math.round(outputBalance.fuelPerDeposit));
  const manpowerPerCity = Math.max(0, Math.round(outputBalance.manpowerPerCity));
  const manpowerPerCapital = Math.max(0, Math.round(outputBalance.manpowerPerCapital));
  const manpowerPerCityMicro = Math.max(0, outputBalance.manpowerPerCityMicro);
  const manpowerPerCapitalMicro = Math.max(0, outputBalance.manpowerPerCapitalMicro);
  const weaponsPerCity = Math.max(0, outputBalance.weaponsPerCity);
  const weaponsPerCapital = Math.max(0, outputBalance.weaponsPerCapital);

  const outputs = new Map<NationId, ResourceOutput>();
  const ensureOutput = (nationId: NationId): ResourceOutput => {
    const existing = outputs.get(nationId);
    if (existing) {
      return existing;
    }
    const created = { steel: 0, fuel: 0, manpower: 0, weaponCapacity: 0 };
    outputs.set(nationId, created);
    return created;
  };

  const occupiedDeposits = getOperatingOccupiedDeposits(world);
  const recovering = !!world.industrialRecovery?.size;
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    if (occupier && occupier !== owner) {
      if (occupiedDeposits.has(meso.id) && isStrategicResource(meso.resource)) {
        const output = ensureOutput(occupier);
        output[meso.resource] = (output[meso.resource] ?? 0) + 1;
      }
      continue;
    }

    const output = ensureOutput(owner);
    const factor = annexedOutputFactor(world, owner, meso.id) *
      (recovering ? industrialRecoveryFactor(world, owner, meso.id) : 1);
    if (meso.resource === "steel") {
      output.steel += steelPerDeposit * factor;
    } else if (meso.resource === "fuel") {
      output.fuel += fuelPerDeposit * factor;
    } else if (isStrategicResource(meso.resource)) {
      output[meso.resource] = (output[meso.resource] ?? 0) + 2 * factor;
    }

    const microCount = meso.microRegionIds.length;
    if (meso.building === "city") {
      output.manpower += (manpowerPerCity + manpowerPerCityMicro * microCount) * factor;
      output.weaponCapacity += weaponsPerCity * factor;
    } else if (meso.building === "capital") {
      output.manpower += (manpowerPerCapital + manpowerPerCapitalMicro * microCount) * factor;
      output.weaponCapacity += weaponsPerCapital * factor;
    }
  }

  return outputs;
}

function applyResourceOutputs(
  nations: WorldState["nations"],
  outputs: Map<NationId, ResourceOutput>,
  upkeep: ReturnType<typeof collectFuelUpkeep>,
  flowByNation: Map<NationId, NationResourceFlow>,
  world: WorldState,
  fielded: Map<NationId, DomainUnitCounts>,
  wars: ReturnType<typeof buildWarAdjacency> | undefined,
  manualGovernment?: NationId,
): boolean {
  const outputBalance = WORLD_BALANCE.resources.output;
  const baseSteelPerWeapon = Math.max(0, Math.round(outputBalance.steelPerWeapon));
  const researchEnabled = !!world.settings?.researchEnabled;
  let transportAvailabilityChanged = false;

  for (const nation of nations) {
    if (!isNationActive(nation)) {
      continue;
    }
    const resources = nation.resources;
    const fuelBeforeOutput = resources.fuel;
    const steelPerWeapon = baseSteelPerWeapon;
    const flow = getFlow(flowByNation, nation.id);
    const output = outputs.get(nation.id);
    const counts = fielded.get(nation.id);
    const atWar = wars?.has(nation.id) ?? false;
    const autonomous = !!wars && nation.id !== manualGovernment;
    const target = wars ? weaponReserve(nation, (counts?.land ?? 0) + (counts?.naval ?? 0), atWar) : 0;
    if (output) {
      for (const resource of STRATEGIC_RESOURCES) {
        if (output[resource] === undefined) continue;
        flow.income[resource] = output[resource];
        resources[resource] = (resources[resource] ?? 0) + output[resource];
      }
      const steelIncome = Math.max(0, output.steel);
      const fuelIncome = Math.max(0, output.fuel);
      const manpowerIncome = Math.max(0, output.manpower);
      flow.income.steel += steelIncome;
      flow.income.fuel += fuelIncome;
      flow.income.manpower += manpowerIncome;
      resources.steel = Math.max(0, resources.steel + steelIncome);
      resources.fuel = Math.max(0, resources.fuel + fuelIncome);
      resources.manpower = Math.max(0, resources.manpower + manpowerIncome);

      const weaponCapacity = Math.max(0, output.weaponCapacity);
      const maxWeapons = autonomous ? Math.min(Math.floor(weaponCapacity),
        Math.ceil(Math.max(0, target - resources.weapons))) : Math.floor(weaponCapacity);
      const protectedSteel = autonomous ? steelForResearch(nation, atWar, researchEnabled) : researchEnabled ? 8 : 0;
      const maxBySteel =
        steelPerWeapon > 0
          ? Math.floor(Math.max(0, resources.steel - protectedSteel) / steelPerWeapon)
          : maxWeapons;
      const weaponsProduced = Math.max(0, Math.min(maxWeapons, maxBySteel));
      if (weaponsProduced > 0) {
        if (steelPerWeapon > 0) {
          const steelUse = weaponsProduced * steelPerWeapon;
          flow.usage.steel += steelUse;
          resources.steel = Math.max(0, resources.steel - steelUse);
        }
        flow.income.weapons += weaponsProduced;
        resources.weapons = Math.max(0, resources.weapons + weaponsProduced);
      }
    }

    const prototypeFuelReserve = autonomous && researchEnabled && !atWar
      ? fuelForPrototypes(nation, fuelBeforeOutput, flow.income.fuel) : 0;
    if (wars) {
      flow.industry = { output: { ...flow.income }, fuelDemand: 0, fuelConsumed: 0, weaponsTarget: target,
        weaponDemandAverage: nation.resourceFlow.industry?.weaponDemandAverage ?? 0, weaponsForRecruitment: 0, prototypeFuelReserve };
    }
    const requests = upkeep.get(nation.id);
    if (requests && settleFuelUpkeep(resources, flow, requests)) transportAvailabilityChanged = true;
  }
  return transportAvailabilityChanged;
}

function settleFuelUpkeep(resources: NationResources, flow: NationResourceFlow, requests: readonly UpkeepRequest[]): boolean {
  const available = Math.max(0, resources.fuel - (flow.industry?.prototypeFuelReserve ?? 0));
  const { demand, consumed, transportAvailabilityChanged } = allocateFuelUpkeep(requests, available);
  resources.fuel -= consumed;
  flow.usage.fuel += consumed;
  if (flow.industry) {
    flow.industry.fuelDemand += demand;
    flow.industry.fuelConsumed += consumed;
  } else {
    flow.fuelUpkeepDemand = (flow.fuelUpkeepDemand ?? 0) + demand;
  }
  return transportAvailabilityChanged;
}

function pickAffordableUnitType(
  resources: NationResources,
  rng: WorldState["simRng"],
  designs?: Partial<Record<UnitType, WeaponDesign>>,
  allowTank = true,
): UnitType | null {
  const canInfantry = canAffordUnit(resources, "Infantry", designs?.Infantry);
  const canTank = canAffordUnit(resources, "Tank", designs?.Tank);
  if (canInfantry && canTank) {
    const tankShare = clamp(WORLD_BALANCE.unit.tankShare, 0, 1);
    const roll = rng.nextFloat();
    return allowTank && roll < tankShare ? "Tank" : "Infantry";
  }
  if (allowTank && canTank) {
    return "Tank";
  }
  if (canInfantry) {
    return "Infantry";
  }
  return null;
}

function pickNavalUnitType(
  resources: NationResources,
  forcedType: NavalUnitType,
  design?: WeaponDesign,
): NavalUnitType | null {
  return canAffordUnit(resources, forcedType, design) ? forcedType : null;
}

function consumeResourcesForUnit(
  resources: NationResources,
  unitType: UnitType,
  usage?: NationResources,
  design?: WeaponDesign,
): boolean {
  if (!canAffordUnit(resources, unitType, design)) {
    return false;
  }
  const weaponCost = getDevelopedUnitWeaponCost(unitType, design);
  const manpowerCost = getUnitManpowerCost(unitType);
  for (const resource of STRATEGIC_RESOURCES) {
    const cost = UNIT_MATERIAL_COSTS[unitType][resource] ?? 0;
    if (resources[resource] === undefined || !cost) continue;
    resources[resource] -= cost;
    if (usage) usage[resource] = (usage[resource] ?? 0) + cost;
  }
  resources.weapons = Math.max(0, resources.weapons - weaponCost);
  resources.manpower = Math.max(0, resources.manpower - manpowerCost);
  if (usage) {
    usage.weapons += weaponCost;
    usage.manpower += manpowerCost;
  }
  return true;
}

const UNIT_MATERIAL_COSTS: Record<UnitType, Partial<Record<StrategicResource, number>>> = {
  Infantry: {},
  Tank: { rubber: 3, tungsten: 3 },
  CombatShip: { copper: 3, tungsten: 4 },
  TransportShip: { copper: 2, rubber: 2 },
};

function canAffordUnit(resources: NationResources, unitType: UnitType, design?: WeaponDesign): boolean {
  const weaponCost = getDevelopedUnitWeaponCost(unitType, design);
  const manpowerCost = getUnitManpowerCost(unitType);
  return resources.weapons >= weaponCost && resources.manpower >= manpowerCost &&
    STRATEGIC_RESOURCES.every((resource) => resources[resource] === undefined ||
      resources[resource] >= (UNIT_MATERIAL_COSTS[unitType][resource] ?? 0));
}

function getUnitManpowerCost(unitType: UnitType): number {
  const value = WORLD_BALANCE.unit.types[unitType].manpower ?? 0;
  return Math.max(0, Math.round(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countOwnedMacroRegions(
  nationId: NationId,
  macroRegions: MacroRegion[],
  occupiedMacroById: Map<MacroRegion["id"], NationId>,
): number {
  let count = 0;
  for (const macro of macroRegions) {
    if (macro.nationId !== nationId) {
      continue;
    }
    const occupier = occupiedMacroById.get(macro.id);
    if (occupier && occupier !== nationId) {
      continue;
    }
    count += 1;
  }
  return count;
}

function isOwnedAndUnoccupied(
  mesoId: MesoRegionId,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (ownerByMesoId.get(mesoId) !== nationId) {
    return false;
  }
  const occupier = occupationByMesoId.get(mesoId);
  if (occupier && occupier !== nationId) {
    return false;
  }
  return true;
}

interface DomainUnitCounts {
  land: number;
  naval: number;
}

function collectUnitCountsByNation(units: readonly UnitState[]): Map<NationId, DomainUnitCounts> {
  const counts = new Map<NationId, DomainUnitCounts>();
  for (const unit of units) for (const nationId of new Set([unit.nationId, ...(unit.volunteerOriginId ? [unit.volunteerOriginId] : [])])) {
    const count = counts.get(nationId) ?? { land: 0, naval: 0 };
    if (unit.domain === "naval") count.naval += 1;
    else count.land += 1;
    counts.set(nationId, count);
  }
  return counts;
}

function updateCapacityDiagnostics(
  world: WorldState,
  countsByNation: ReadonlyMap<NationId, DomainUnitCounts>,
  mobilized: readonly UnitState[],
): void {
  let currentLandUnits = 0;
  let currentNavalUnits = 0;
  for (const counts of countsByNation.values()) {
    currentLandUnits += counts.land;
    currentNavalUnits += counts.naval;
  }
  // Capacity is charged to both countries; the global headcount still counts each soldier once.
  if (world.volunteers) for (const unit of mobilized) if (unit.volunteerOriginId && unit.volunteerOriginId !== unit.nationId) {
    if (unit.domain === "land") currentLandUnits--; else currentNavalUnits--;
  }
  const diagnostics = world.productionDiagnostics;
  const changed = diagnostics.currentLandUnits !== currentLandUnits ||
    diagnostics.currentNavalUnits !== currentNavalUnits;
  diagnostics.currentLandUnits = currentLandUnits;
  diagnostics.currentNavalUnits = currentNavalUnits;
  diagnostics.peakLandUnits = Math.max(diagnostics.peakLandUnits, currentLandUnits);
  diagnostics.peakNavalUnits = Math.max(diagnostics.peakNavalUnits, currentNavalUnits);
  if (changed) diagnostics.version += 1;
}
