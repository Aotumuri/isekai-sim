import type { UnitState } from "../unit";
import type { WorldState } from "../world-state";
import { isAmphibiousOwnedUnit } from "../amphibious";
import { isPlayerDirectedLandUnit } from "../player-land-orders";

export type MovementLeg = Pick<UnitState,
  "regionId" | "moveTargetId" | "moveFromId" | "moveToId" | "moveProgressMs">;
interface MarchMission { nation: string; front: string; revision: number }
type CampaignMarchLeg = MovementLeg & { mission: MarchMission };
const missionsByWorld = new WeakMap<WorldState, Map<UnitState["id"], MarchMission>>();

export function clearCampaignMarchMissions(world: WorldState): void { missionsByWorld.delete(world); }

/** Remember only the preceding pass's ordinary mission, never an old route.
 * This is also called without reassignment so intervening role changes count. */
export function captureCampaignMarchLegs(world: WorldState, units: UnitState[], reassign: boolean): Map<UnitState["id"], CampaignMarchLeg> | undefined {
  if (!world.settings?.warCampaignEnabled) { clearCampaignMarchMissions(world); return; }
  const previous = missionsByWorld.get(world);
  const next = new Map<UnitState["id"], MarchMission>();
  const legs = new Map<UnitState["id"], CampaignMarchLeg>();
  for (const unit of units) {
    const mission = ordinaryMarchMission(world, unit);
    if (!mission) continue;
    next.set(unit.id, mission);
    if (!reassign || !sameMission(previous?.get(unit.id), mission) || !unit.moveToId || unit.moveProgressMs <= 0) continue;
    legs.set(unit.id, { regionId: unit.regionId, moveTargetId: unit.moveTargetId,
      moveFromId: unit.moveFromId, moveToId: unit.moveToId, moveProgressMs: unit.moveProgressMs, mission });
  }
  if (next.size) missionsByWorld.set(world, next); else missionsByWorld.delete(world);
  return legs.size ? legs : undefined;
}

/** Assignment may have changed ownership of a unit's orders within this pass. */
export function discardChangedMarchMissions(world: WorldState, units: UnitState[], legs?: Map<UnitState["id"], CampaignMarchLeg>): void {
  if (!legs) return;
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  for (const [id, leg] of legs) {
    const unit = byId.get(id);
    if (!unit || !sameMission(leg.mission, ordinaryMarchMission(world, unit))) legs.delete(id);
  }
}

function ordinaryMarchMission(world: WorldState, unit: UnitState): MarchMission | undefined {
  const campaign = world.warCampaigns?.byNationId.get(unit.nationId);
  const front = world.frontAllocations.frontIdByUnitId.get(unit.id);
  if (!campaign || campaign.constraints.capitalCritical || !front || !world.landFronts.operationalSectorsById.has(front) ||
    world.playerNation && isPlayerDirectedLandUnit(world.playerNation, unit) || isAmphibiousOwnedUnit(world, unit.id) ||
    world.strategicReserves.reserveNationByUnitId.has(unit.id) || world.retreatPlans.retreatIdByUnitId.has(unit.id) ||
    world.reorganization.planIdByUnitId.has(unit.id) || world.offensiveOperations.operationIdByUnitId.has(unit.id)) return;
  return { nation: unit.nationId, front, revision: campaign.revision };
}

function sameMission(before?: MarchMission, after?: MarchMission): boolean {
  return !!before && !!after && before.nation === after.nation && before.front === after.front && before.revision === after.revision;
}

/** Called after routing has validated the new first edge. Enemy blocking and
 * arrival still run normally, so failed arrivals cannot accumulate old time. */
export function retainedRetargetProgress(unit: MovementLeg, previous: MovementLeg | undefined, dtMs: number): number {
  if (!previous || !unit.moveTargetId || previous.moveTargetId === unit.moveTargetId ||
    !previous.moveToId || previous.moveFromId !== previous.regionId ||
    previous.regionId !== unit.regionId || unit.moveFromId !== previous.moveFromId ||
    unit.moveToId !== previous.moveToId) return unit.moveProgressMs;
  return Math.max(unit.moveProgressMs, previous.moveProgressMs + dtMs);
}
