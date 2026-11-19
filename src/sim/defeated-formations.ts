import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getMoveTicksPerRegion } from "./movement";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { recordSimulationEvent } from "./simulation-settings";
import type { UnitId, UnitState } from "./unit";
import { observeCampaignFormationRemoval } from "./war-campaign/battle-cost-observation";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "./war-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

interface Withdrawal {
  unit: UnitState;
  destination: MesoRegionId;
  arrivalTick: number;
  arrived: boolean;
}

interface PrisonerGroup {
  captor: NationId;
  belligerent: NationId;
  home: NationId;
  manpower: number;
  releaseAt?: number;
}

export function prisonerGroupKey(captor: NationId, belligerent: NationId, home: NationId): string {
  return `${captor}:${belligerent}:${home}`;
}

export interface DefeatedFormations {
  withdrawals: Map<UnitId, Withdrawal>;
  prisoners: Map<string, PrisonerGroup>;
  recoveredManpower: number;
  capturedManpower: number;
  missingManpower: number;
  repatriatedManpower: number;
  displacedManpower: number;
}

interface WithdrawalConditions {
  wars: WarAdjacency;
  threats: Map<MesoRegionId, Set<NationId>>;
}

const REPATRIATION_DELAY = 10; // Slow ticks after hostilities end.

function getState(world: WorldState): DefeatedFormations {
  return world.defeatedFormations ??= {
    withdrawals: new Map(),
    prisoners: new Map(),
    recoveredManpower: 0,
    capturedManpower: 0,
    missingManpower: 0,
    repatriatedManpower: 0,
    displacedManpower: 0,
  };
}

function buildConditions(world: WorldState): WithdrawalConditions {
  const threats = new Map<MesoRegionId, Set<NationId>>();
  for (const unit of world.units) {
    if (unit.domain !== "land" || unit.org <= 0 || unit.manpower <= 0) continue;
    for (const id of [unit.regionId, unit.moveToId]) {
      if (!id) continue;
      const nations = threats.get(id) ?? new Set<NationId>();
      nations.add(unit.nationId);
      threats.set(id, nations);
    }
  }
  return { wars: buildWarAdjacency(world.wars), threats };
}

function hostileAt(world: WorldState, conditions: WithdrawalConditions, unit: UnitState, id: MesoRegionId): NationId | undefined {
  const occupier = world.occupation.mesoById.get(id);
  if (occupier && isAtWar(unit.nationId, occupier, conditions.wars)) return occupier;
  return [...(conditions.threats.get(id) ?? [])]
    .filter((nation) => isAtWar(unit.nationId, nation, conditions.wars)).sort()[0];
}

function canRally(world: WorldState, conditions: WithdrawalConditions, unit: UnitState, id: MesoRegionId): boolean {
  const occupier = world.occupation.mesoById.get(id);
  return getOwnerByMesoId(world).get(id) === unit.nationId &&
    (!occupier || occupier === unit.nationId) && getMesoById(world).get(id)?.type !== "sea" &&
    !hostileAt(world, conditions, unit, id);
}

function recordLoss(world: WorldState, unit: UnitState, captor?: NationId): void {
  const state = getState(world);
  observeCampaignFormationRemoval(world, unit);
  if (!captor) {
    state.missingManpower += unit.manpower;
    recordSimulationEvent(world, { category: "military", nationIds: [unit.nationId],
      message: `${unit.nationId} lost contact with ${Math.round(unit.manpower)} personnel when ${unit.id} broke.` });
    return;
  }
  const home = unit.volunteerOriginId ?? unit.exileOriginId ?? unit.nationId;
  const key = prisonerGroupKey(captor, unit.nationId, home);
  const group = state.prisoners.get(key) ?? { captor, belligerent: unit.nationId, home, manpower: 0 };
  group.manpower += unit.manpower;
  group.releaseAt = undefined;
  state.prisoners.set(key, group);
  state.capturedManpower += unit.manpower;
  recordSimulationEvent(world, { category: "military", nationIds: [...new Set([captor, unit.nationId, home])],
    message: `${captor} took ${Math.round(unit.manpower)} prisoners after ${unit.id} of ${unit.nationId} broke.` });
}

/** Called after all defeated units have left the field roster. */
export function beginDefeatedWithdrawals(world: WorldState, routed: Map<UnitState, NationId | undefined>): void {
  if (!routed.size) return;
  const conditions = buildConditions(world);
  const neighbors = getNeighborsById(world);
  const state = getState(world);
  for (const [unit, opponent] of routed) {
    if (world.playerNation?.landOrders.delete(unit.id)) world.playerNation.commandRevision++;
    unit.moveTargetId = unit.moveFromId = unit.moveToId = null;
    unit.moveProgressMs = 0;
    unit.amphibiousEmbarkRequested = unit.amphibiousLandRequested = false;
    const destination = [...(neighbors.get(unit.regionId) ?? [])].sort()
      .find((id) => canRally(world, conditions, unit, id));
    if (!destination) {
      recordLoss(world, unit, hostileAt(world, conditions, unit, unit.regionId) ?? opponent);
      continue;
    }
    // Dispersed tank crews can withdraw on foot if their vehicles are stranded.
    const speed = getMoveTicksPerRegion(unit);
    if (!Number.isFinite(speed)) for (const slot of unit.equipment) slot.fill = 0;
    const footPace = WORLD_BALANCE.unit.types.Infantry.moveTicksPerRegion;
    const travelTicks = Math.ceil(Number.isFinite(speed) ? Math.max(footPace, speed) : footPace);
    state.withdrawals.set(unit.id, { unit, destination, arrivalTick: world.time.fastTick + travelTicks, arrived: false });
    recordSimulationEvent(world, { category: "military", nationIds: [unit.nationId],
      message: `${unit.id} of ${unit.nationId} broke and is withdrawing with ${Math.round(unit.manpower)} personnel.` });
  }
}

/** Process after occupation so the new control of a rally district is visible. */
export function advanceDefeatedWithdrawals(world: WorldState): void {
  const state = world.defeatedFormations;
  if (!state?.withdrawals.size) return;
  const conditions = buildConditions(world);
  for (const [id, retreat] of state.withdrawals) {
    const { unit, destination, arrivalTick } = retreat;
    if (!canRally(world, conditions, unit, destination)) {
      recordLoss(world, unit, hostileAt(world, conditions, unit, unit.regionId) ?? hostileAt(world, conditions, unit, destination));
      state.withdrawals.delete(id);
    } else if (!retreat.arrived && world.time.fastTick >= arrivalTick) {
      retreat.arrived = true;
      unit.regionId = destination;
    }
  }
}

export function recoverDefeatedFormations(world: WorldState): void {
  const state = world.defeatedFormations;
  if (!state?.withdrawals.size) return;
  // Peace and territorial transfers can change control during the slow tick.
  advanceDefeatedWithdrawals(world);
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const ready: UnitState[] = [];
  for (const [id, { unit, arrived, arrivalTick }] of state.withdrawals) {
    if (!arrived || world.time.fastTick <= arrivalTick) continue;
    unit.org = Math.min(settings.readyOrganizationRatio,
      unit.org + settings.organizationRecoveryPerSlowTick * (unit.design?.recovery ?? 1));
    if (unit.org < settings.readyOrganizationRatio) continue;
    ready.push(unit);
    state.withdrawals.delete(id);
    state.recoveredManpower += unit.manpower;
    recordSimulationEvent(world, { category: "military", nationIds: [unit.nationId],
      message: `${unit.id} of ${unit.nationId} rallied with ${Math.round(unit.manpower)} personnel and returned to service.` });
  }
  if (ready.length) world.units = [...world.units, ...ready];
}

export function creditReturnedPrisoners(state: DefeatedFormations, nation: NationRuntime, manpower: number): void {
  nation.resources.manpower += manpower;
  nation.resourceFlow.income.manpower += manpower;
  nation.resourceFlow.delta.manpower += manpower;
  state.repatriatedManpower += manpower;
}

export function repatriatePrisoners(world: WorldState): void {
  const state = world.defeatedFormations;
  if (!state?.prisoners.size) return;
  const active = new Map(world.nations.filter(isNationActive).map((nation) => [nation.id, nation]));
  const wars = buildWarAdjacency(world.wars);
  const now = world.time.slowTick;
  for (const [key, group] of state.prisoners) {
    if (active.has(group.captor) && isAtWar(group.captor, group.belligerent, wars)) {
      group.releaseAt = undefined;
      continue;
    }
    group.releaseAt ??= now + REPATRIATION_DELAY;
    if (now < group.releaseAt) continue;
    const home = active.get(group.home) ?? active.get(group.belligerent);
    if (home) {
      creditReturnedPrisoners(state, home, group.manpower);
      recordSimulationEvent(world, { category: "military", nationIds: [group.captor, home.id],
        message: `${Math.round(group.manpower)} prisoners returned from ${group.captor} to the manpower pool of ${home.id}.` });
    } else {
      state.displacedManpower += group.manpower;
      recordSimulationEvent(world, { category: "military", nationIds: [group.captor, group.home],
        message: `${Math.round(group.manpower)} prisoners left captivity in ${group.captor} without a surviving government to receive them.` });
    }
    state.prisoners.delete(key);
  }
}
