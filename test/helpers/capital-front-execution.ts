import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { getFrontlineAssignment } from "../../src/sim/frontline-coverage";
import { getFrontSide } from "../../src/sim/land-fronts";
import { getFrontAllocation } from "../../src/sim/nation-front-allocations";
import { getNationFrontPlans } from "../../src/sim/nation-front-plans";
import { getOffensiveOperationForFront } from "../../src/sim/offensive-operations";
import { isPlayerDirectedLandUnit } from "../../src/sim/player-land-orders";
import { getPlayerNation } from "../../src/sim/player-nation";
import type { UnitId, UnitState } from "../../src/sim/unit";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getWarCampaign } from "../../src/sim/war-campaign/state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";

type MissionState = ReturnType<typeof describeMission>["state"];
type UnitEvidence = ReturnType<typeof describeUnit>;
type Event = { tick: number } & (
  | { kind: "mission"; state: MissionState & { status: string; capitalUnits: number; capitalStrength: number;
      inPositionStrength: number; fieldAssignedCount: number }; previousSectorPresent: boolean | null }
  | { kind: "unit"; id: UnitId; before: UnitEvidence | null; after: UnitEvidence | null;
      presence: "field" | "transport" | "not-observed"; otherNationId: NationId | null }
);

export function createCapitalFrontExecutionObserver(nationId: NationId, capitalId: MesoRegionId, limit = 1500) {
  const events: Event[] = [];
  let omittedEvents = 0;
  let previousMission = "";
  let previousSectorId: MissionState["sectorId"] = null;
  let previousUnits = new Map<UnitId, UnitEvidence>();
  let samples = 0;
  let lastTick = -1;
  const ticksByState = { inactive: 0, noSector: 0, noPlan: 0, noAllocation: 0, noUnits: 0, noStrengthInPosition: 0,
    partiallyFilled: 0, filled: 0 };
  let threatenedVacantTicks = 0;
  let threatenedZeroStrengthTicks = 0;

  function add(event: Event) {
    if (events.length < limit) events.push(event);
    else omittedEvents++;
  }

  function observe(world: WorldState) {
    const tick = world.time.fastTick;
    if (tick <= lastTick) return;
    lastTick = tick;
    samples++;
    const { state, assigned, border, operationUnits } = describeMission(world, nationId, capitalId);
    const currentUnits = new Map<UnitId, UnitEvidence>();
    const field = new Map<UnitId, UnitState>();
    const missing = new Set(previousUnits.keys());
    let capitalStrength = 0, capitalUnits = 0, inPositionStrength = 0, fieldAssignedCount = 0;
    for (const unit of world.units) {
      if (previousUnits.has(unit.id)) {
        field.set(unit.id, unit);
        missing.delete(unit.id);
      }
      if (unit.domain !== "land" || unit.nationId !== nationId) continue;
      const atCapital = unit.regionId === capitalId;
      const allocated = assigned.has(unit.id);
      if (!atCapital && !allocated) continue;
      const evidence = describeUnit(world, unit, operationUnits.has(unit.id));
      currentUnits.set(unit.id, evidence);
      const strength = getUnitCombatStrength(unit);
      if (atCapital) { capitalUnits++; capitalStrength += strength; }
      if (allocated) {
        fieldAssignedCount++;
        if (border.has(unit.regionId)) {
          inPositionStrength += strength;
        }
      }
    }
    // Fast ticks can move a unit into cargo without ending its service.
    const carried = new Set<UnitId>();
    if (missing.size) {
      for (const ship of world.units) {
        for (const unit of ship.cargoUnits) if (missing.has(unit.id)) carried.add(unit.id);
      }
    }

    const status = state.threat === "none" ? "inactive"
      : !state.sectorId ? "noSector"
      : !state.plan ? "noPlan"
      : !state.allocation ? "noAllocation"
      : fieldAssignedCount === 0 ? "noUnits"
      : inPositionStrength <= 0 ? "noStrengthInPosition"
      : inPositionStrength < state.plan.desiredStrength ? "partiallyFilled" : "filled";
    if (tick > 0) {
      ticksByState[status]++;
      if (state.threat !== "none" && capitalUnits === 0) threatenedVacantTicks++;
      if (state.threat !== "none" && capitalStrength <= 0) threatenedZeroStrengthTicks++;
    }
    const current = { ...state, status, capitalUnits, capitalStrength, inPositionStrength, fieldAssignedCount };
    const fingerprint = JSON.stringify([state.currentCapital, state.capitalController, state.threat, state.sectorId, state.assessmentSectorId,
      state.campaign?.revision, state.campaign?.adoptedAtTick, state.plan?.posture, state.plan?.reasonFlags,
      state.plan?.desiredStrength, state.plan?.priority, status, capitalUnits,
      capitalStrength > 0, fieldAssignedCount, state.fuelEmpty]);
    if (fingerprint !== previousMission) {
      add({ tick, kind: "mission", state: current,
        previousSectorPresent: previousSectorId ? world.landFronts.operationalSectorsById.has(previousSectorId) : null });
    }
    previousSectorId = state.sectorId;
    previousMission = fingerprint;

    for (const [id, before] of previousUnits) {
      const unit = field.get(id);
      const after = currentUnits.get(id) ?? (unit ? describeUnit(world, unit, operationUnits.has(id)) : null);
      if (currentUnits.has(id) && JSON.stringify(before) === JSON.stringify(after)) continue;
      add({ tick, kind: "unit", id, before, after, presence: unit ? "field" : carried.has(id) ? "transport" : "not-observed",
        otherNationId: unit && unit.nationId !== nationId ? unit.nationId : null });
    }
    for (const [id, after] of currentUnits) {
      if (!previousUnits.has(id)) add({ tick, kind: "unit", id, before: null, after, presence: "field", otherNationId: null });
    }
    previousUnits = currentUnits;
  }

  return {
    observe,
    result: () => ({ nationId, capitalId, samples, lastTick, ticksByState: { ...ticksByState },
      threatenedVacantTicks, threatenedZeroStrengthTicks, omittedEvents, events: [...events] }),
  };
}

function describeMission(world: WorldState, nationId: NationId, capitalId: MesoRegionId) {
  const nation = world.nations.find((item) => item.id === nationId);
  const assessment = world.capitalDefense.assessmentsByNationId.get(nationId);
  const active = assessment?.capitalRegionId === capitalId && nation?.capitalMesoId === capitalId &&
    assessment.threatLevel !== "none" && world.wars.some((war) => war.nationAId === nationId || war.nationBId === nationId);
  const trackedSectorId = active ? assessment.primaryFrontId : null;
  const sector = trackedSectorId ? world.landFronts.operationalSectorsById.get(trackedSectorId) : undefined;
  const plan = sector && getNationFrontPlans(world, nationId).find((item) => item.frontId === sector.id);
  const allocation = sector && getFrontAllocation(world, sector.id, nationId);
  const operation = sector && getOffensiveOperationForFront(world, sector.id, nationId);
  const campaign = getWarCampaign(world, nationId);
  const ownerByMesoId = getOwnerByMesoId(world);
  const controlledBy = (id: MesoRegionId) => world.occupation.mesoById.get(id) ?? ownerByMesoId.get(id);
  const friendlySide = sector && getFrontSide(sector, nationId);
  return {
    assigned: new Set(allocation?.unitIds),
    border: new Set(friendlySide?.borderRegionIds.filter((id) => controlledBy(id) === nationId)),
    operationUnits: new Set(operation && operation.phase !== "recovering" ? operation.assignedUnitIds : []),
    state: {
      currentCapital: nation?.capitalMesoId ?? null, capitalController: controlledBy(capitalId) ?? null, threat: active ? assessment.threatLevel : "none",
      assessedAtTick: assessment?.evaluatedAtTick ?? null, sectorId: sector?.id ?? null,
      assessmentSectorId: trackedSectorId,
      campaign: campaign ? { revision: campaign.revision, adoptedAtTick: campaign.adoptedAtTick,
        mode: campaign.mode, militaryMode: campaign.militaryMode, reason: campaign.reason,
        objectives: campaign.objectives.map(({ warKey, opponentId, kind, regionIds }) => ({ warKey, opponentId, kind, regionIds: [...regionIds] })) } : null,
      plan: plan ? { posture: plan.posture, desiredStrength: plan.desiredStrength, priority: plan.priority,
        reasonFlags: [...plan.reasonFlags], evaluatedAtTick: plan.evaluatedAtTick } : null,
      allocation: allocation ? { allocatedStrength: allocation.allocatedStrength, deficit: allocation.deficit,
        unitCount: allocation.unitIds.length } : null,
      fuelEmpty: (nation?.resources.fuel ?? 0) <= 0,
    },
  };
}

function describeUnit(world: WorldState, unit: UnitState, inOperation: boolean) {
  const id = unit.id;
  const coverage = getFrontlineAssignment(world, id);
  return {
    regionId: unit.regionId, targetId: unit.moveTargetId, nextRegionId: unit.moveToId,
    assignedFront: world.frontAllocations.frontIdByUnitId.get(id) ?? null,
    coverageTarget: coverage?.targetRegionId ?? null,
    hasCombatStrength: getUnitCombatStrength(unit) > 0,
    orders: {
      manual: isPlayerDirectedLandUnit(getPlayerNation(world), unit),
      retreat: world.retreatPlans.retreatIdByUnitId.get(id) ?? null,
      reserve: world.strategicReserves.reserveNationByUnitId.has(id),
      reorganization: world.reorganization.planIdByUnitId.get(id) ?? null,
      amphibious: world.amphibiousOperations.operationByUnitId.has(id) ||
        world.amphibiousOperations.capabilityDemandByUnitId.has(id),
      offensive: inOperation,
    },
  };
}
