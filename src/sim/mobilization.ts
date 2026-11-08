import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import type { NationRuntime } from "./nation-runtime";
import type { UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getNationCharacter } from "./nation-character";
import { getOwnerByMesoId } from "./world-cache";
import { getDevelopedUnitWeaponCost } from "./equipment-development";
import { isNationRegionSupplied } from "./supply-assessment";
import { recordSimulationEvent } from "./simulation-settings";

export type MobilizationPolicy = "automatic" | "limited" | "total";
export type MobilizationPhase = "standing" | "alert" | "mobilizing" | "war" | "demobilizing";
export interface NationalMobilization {
  policy: MobilizationPolicy; phase: MobilizationPhase; readiness: number; threat: number;
  burden: number; continuousDeployment: number; appliedSupportPenalty: number;
  supportBeforeStrain?: number; lastEffectiveSupport?: number;
  standingArmy: number; maximumArmy: number; authorizedArmy: number; landUnits: number; deployedManpower: number;
  quietSinceSlowTick: number; lastSlowTick: number; lastDemobilizationTick: number;
  recruited: number; demobilized: number; returnedManpower: number; recoveredWeapons: number; strainBand: number;
}
export interface MobilizationState { byNationId: Map<NationId, NationalMobilization> }
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export function getMobilization(world: WorldState, nationId: NationId): NationalMobilization {
  const state = world.mobilization ??= { byNationId: new Map() };
  let item = state.byNationId.get(nationId);
  if (!item) {
    item = { policy: "automatic", phase: "standing", readiness: 0, threat: 0, burden: 0, continuousDeployment: 0,
      appliedSupportPenalty: 0, standingArmy: 0, maximumArmy: 0, authorizedArmy: 0, landUnits: 0, deployedManpower: 0,
      quietSinceSlowTick: world.time.slowTick, lastSlowTick: world.time.slowTick, lastDemobilizationTick: -5,
      recruited: 0, demobilized: 0, returnedManpower: 0, recoveredWeapons: 0, strainBand: 0 };
    state.byNationId.set(nationId, item);
  }
  return item;
}
export function allFieldUnits(world: WorldState): UnitState[] {
  const result: UnitState[] = [], seen = new Set<string>();
  const visit = (unit: UnitState) => {
    if (seen.has(unit.id)) return; seen.add(unit.id); result.push(unit);
    for (const cargo of unit.cargoUnits) visit(cargo);
  };
  for (const unit of world.units) visit(unit);
  for (const mission of world.volunteers?.missions ?? []) for (const unit of mission.transitUnits) visit(unit);
  return result;
}
export function getMobilizationThreat(world: WorldState, nationId: NationId): number {
  if (world.wars.some((war) => war.nationAId === nationId || war.nationBId === nationId)) return 1;
  const owners = getOwnerByMesoId(world), nearby = new Set<NationId>();
  for (const exposure of world.strategicThreatObservation.exposures) if (exposure.observerNationId === nationId && (exposure.landAdjacent || exposure.sharedSeaComponent)) nearby.add(exposure.threatNationId);
  // Diplomacy works before the first strategic snapshot, too.
  for (const region of world.mesoRegions) if (owners.get(region.id) === nationId) for (const neighbor of region.neighbors) {
    const owner = owners.get(neighbor.id); if (owner && owner !== nationId) nearby.add(owner);
  }
  let threat = 0;
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    if (relation.nationAId !== nationId && relation.nationBId !== nationId) continue;
    const other = relation.nationAId === nationId ? relation.nationBId : relation.nationAId;
    if (relation.crisis) threat = Math.max(threat, 0.75);
    if (!nearby.has(other) || relation.treaties.some((treaty) => ["truce", "alliance", "non-aggression"].includes(treaty.type) && treaty.expiresAtSlowTick > world.time.slowTick)) continue;
    if (relation.tension >= 55 && (relation.opinion < -15 || relation.grievance >= 25)) threat = Math.max(threat, relation.tension >= 80 ? 0.6 : 0.35);
    const enemy = world.mobilization?.byNationId.get(other);
    if (enemy && enemy.readiness >= 0.5 && relation.opinion < -20) threat = Math.max(threat, 0.5);
  }
  for (const intent of world.warIntent.assessmentsByNationId.get(nationId) ?? []) if (
    world.time.fastTick - intent.evaluatedAtTick <= 120 && intent.aboveThreshold) threat = Math.max(threat, 0.55);
  return threat;
}
export function getArmyLimits(world: WorldState, nation: NationRuntime, item = getMobilization(world, nation.id)) {
  const owners = getOwnerByMesoId(world);
  let districts = 0, cities = 0;
  for (const region of world.mesoRegions) if (region.type !== "sea" && owners.get(region.id) === nation.id &&
    (!world.occupation.mesoById.has(region.id) || world.occupation.mesoById.get(region.id) === nation.id)) {
    districts++; if (region.building === "city" || region.building === "capital") cities++;
  }
  const populationCeiling = Math.min(WORLD_BALANCE.production.maxMobilizedLandUnits, Math.max(24, districts * 8 + cities * 6));
  const support = clamp(nation.warCooperation), personality = getNationCharacter(world, nation.id);
  const maximum = Math.max(4, Math.floor(populationCeiling * (0.2 + support * 0.8) * (1 - item.burden * 0.003)));
  const standing = Math.min(maximum, Math.max(3, Math.min(24, Math.ceil(3 + cities * 0.65 + districts * 0.08 + personality.aggression * 2))));
  return { standing, maximum, authorized: Math.max(standing, Math.floor(standing + (maximum - standing) * item.readiness)) };
}
export function updateMobilization(world: WorldState): void {
  if (!world.settings?.mobilizationEnabled) {
    for (const item of world.mobilization?.byNationId.values() ?? []) { item.lastSlowTick = world.time.slowTick; item.quietSinceSlowTick = world.time.slowTick; }
    return;
  }
  const units = allFieldUnits(world);
  const threats = new Map(world.nations.map((nation) => [nation.id, getMobilizationThreat(world, nation.id)]));
  for (const nation of world.nations) {
    if (!nation.macroRegionIds.length) continue;
    const item = getMobilization(world, nation.id), elapsed = Math.max(0, world.time.slowTick - item.lastSlowTick);
    if (!elapsed && item.standingArmy > 0) continue;
    const previousThreat = item.threat, previousPhase = item.phase;
    const atWar = world.wars.some((war) => war.nationAId === nation.id || war.nationBId === nation.id);
    item.threat = threats.get(nation.id) ?? 0;
    if (item.policy === "total") item.threat = Math.max(item.threat, 0.95);
    let desired = item.policy === "limited" && !atWar ? Math.min(0.4, item.threat) : item.threat;
    // Ambiguous warnings do not justify permanent mass conscription against civilian opposition.
    if (!atWar && item.threat < 0.7) desired *= 1 - item.burden * 0.008;
    const direction = desired - item.readiness;
    item.readiness = clamp(item.readiness + Math.sign(direction) * Math.min(Math.abs(direction), elapsed * (direction > 0 ? 0.025 : 0.012)));
    if (item.threat >= 0.7) item.quietSinceSlowTick = world.time.slowTick;
    const limits = getArmyLimits(world, nation, item);
    item.standingArmy = limits.standing; item.maximumArmy = limits.maximum; item.authorizedArmy = limits.authorized;
    const ownUnits = units.filter((unit) => (unit.volunteerOriginId ?? unit.nationId) === nation.id);
    item.landUnits = ownUnits.filter((unit) => unit.domain === "land" && unit.manpower > 0).length;
    item.deployedManpower = ownUnits.reduce((sum, unit) => sum + Math.max(0, unit.manpower) * (unit.domain === "naval" ? 0.5 : 1), 0);
    const support = clamp(nation.warCooperation), safeShare = atWar ? 0.3 + support * 0.2 : 0.12;
    const populationCapacity = Math.max(24, Math.min(WORLD_BALANCE.production.maxMobilizedLandUnits, limits.maximum / Math.max(0.2, 0.2 + support * 0.8)));
    const share = item.deployedManpower / (populationCapacity * WORLD_BALANCE.unit.types.Infantry.manpower);
    if (item.landUnits > item.standingArmy) item.continuousDeployment += elapsed;
    else item.continuousDeployment = Math.max(0, item.continuousDeployment - elapsed * 3);
    const fatigue = 1 + Math.min(1, item.continuousDeployment / 300);
    const change = share > safeShare ? (share - safeShare) * 0.18 * (atWar ? 0.65 : 1.35) * (1.2 - support * 0.45) * fatigue : -(atWar ? 0.04 : 0.18);
    item.burden = clamp(item.burden + change * elapsed, 0, 100);
    item.phase = atWar ? "war" : item.threat >= 0.7 ? "mobilizing" : item.threat > 0.05 ? "alert" : item.readiness > 0.01 || item.landUnits > item.authorizedArmy ? "demobilizing" : "standing";
    if (item.threat > previousThreat && item.threat >= 0.35) nation.nextUnitProductionTick = Math.min(nation.nextUnitProductionTick, world.time.slowTick + 2);
    item.lastSlowTick = world.time.slowTick;
    const band = item.burden >= 70 ? 2 : item.burden >= 40 ? 1 : 0;
    if (previousPhase !== item.phase || band !== item.strainBand) recordSimulationEvent(world, { category: "military", nationIds: [nation.id],
      message: `${nation.id}: ${item.phase}; public strain ${Math.round(item.burden)}/100, authorized army ${item.authorizedArmy}.` });
    item.strainBand = band;
  }
}
/** Restore the latent support value without losing it when strain clamps the displayed value to zero. */
export function restoreMobilizationSupport(world: WorldState, nation: NationRuntime): void {
  const item = world.mobilization?.byNationId.get(nation.id);
  if (item?.supportBeforeStrain !== undefined && item.lastEffectiveSupport !== undefined) {
    nation.warCooperation = clamp(item.supportBeforeStrain + nation.warCooperation - item.lastEffectiveSupport);
  }
}
/** Called once after the existing battlefield support calculation, never accumulated per frame. */
export function applyMobilizationSupport(world: WorldState, nation: NationRuntime): void {
  const item = world.mobilization?.byNationId.get(nation.id); if (!item) return;
  item.appliedSupportPenalty = world.settings?.mobilizationEnabled ? item.burden * 0.004 : 0;
  item.supportBeforeStrain = nation.warCooperation;
  nation.warCooperation = clamp(nation.warCooperation - item.appliedSupportPenalty);
  item.lastEffectiveSupport = nation.warCooperation;
}
export function updateDemobilization(world: WorldState): void {
  if (!world.settings?.mobilizationEnabled) return;
  const owners = getOwnerByMesoId(world), removed = new Set<string>();
  for (const nation of world.nations) {
    const item = world.mobilization?.byNationId.get(nation.id);
    if (!item || !nation.macroRegionIds.length || item.threat >= 0.7 || world.time.slowTick - item.quietSinceSlowTick < 30 ||
      world.time.slowTick - item.lastDemobilizationTick < 5 || world.wars.some((war) => war.nationAId === nation.id || war.nationBId === nation.id)) continue;
    const ownUnits = allFieldUnits(world).filter((unit) => unit.nationId === nation.id);
    const actual = ownUnits.filter((unit) => unit.domain === "land").length;
    const excess = Math.max(0, actual - item.authorizedArmy), batch = Math.min(excess, Math.max(2, Math.ceil(actual * 0.05)));
    const candidates = world.units.filter((unit) => unit.nationId === nation.id && unit.domain === "land" && unit.manpower > 0 && unit.cargoUnits.length === 0 && !unit.volunteerOriginId && !world.militaryAccess?.orders.has(unit.id) &&
      owners.get(unit.regionId) === nation.id && !world.occupation.mesoById.has(unit.regionId) &&
      (!unit.moveToId || owners.get(unit.moveToId) === nation.id) && !unit.amphibiousEmbarkRequested && !unit.amphibiousLandRequested &&
      !world.amphibiousOperations.operationByUnitId.has(unit.id) && !world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) && !world.offensiveOperations.operationIdByUnitId.has(unit.id) &&
      !world.retreatPlans.retreatIdByUnitId.has(unit.id) && !world.reorganization.planIdByUnitId.has(unit.id) &&
      !world.battles.some((battle) => battle.mesoId === unit.regionId) && isNationRegionSupplied(world, nation.id, unit.regionId)).sort((a, b) => a.org - b.org || a.id.localeCompare(b.id));
    let count = 0;
    for (const unit of candidates.slice(0, batch)) {
      const manpower = Math.max(0, unit.manpower), health = clamp(manpower / WORLD_BALANCE.unit.types[unit.type].manpower);
      const weapons = getDevelopedUnitWeaponCost(unit.type, unit.design) * health * 0.6;
      nation.resources.manpower += manpower; nation.resources.weapons += weapons;
      nation.resourceFlow.income.manpower += manpower; nation.resourceFlow.delta.manpower += manpower;
      nation.resourceFlow.income.weapons += weapons; nation.resourceFlow.delta.weapons += weapons;
      item.returnedManpower += manpower; item.recoveredWeapons += weapons; item.demobilized++; removed.add(unit.id); count++;
    }
    if (!count) continue;
    item.lastDemobilizationTick = world.time.slowTick; item.landUnits = actual - count;
    nation.initialUnitCount = Math.max(ownUnits.length - count, nation.initialUnitCount - count);
    nation.unitRoles.defenseUnitIds = nation.unitRoles.defenseUnitIds.filter((id) => !removed.has(id));
    nation.unitRoles.occupationUnitIds = nation.unitRoles.occupationUnitIds.filter((id) => !removed.has(id));
    recordSimulationEvent(world, { category: "military", nationIds: [nation.id], message: `${nation.id} demobilized ${count} units; surviving personnel returned and equipment was partly recovered.` });
  }
  if (removed.size) world.units = world.units.filter((unit) => !removed.has(unit.id));
}
