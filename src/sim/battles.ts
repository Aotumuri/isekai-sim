import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getMesoById } from "./world-cache";
import {
  addWarContribution,
  buildWarAdjacency,
  isAtWar,
  normalizeWarPair,
  type WarAdjacency,
} from "./war-state";

export type BattleId = string & { __brand: "BattleId" };

export interface BattleState {
  id: BattleId;
  mesoId: MesoRegionId;
  attackerNationId: NationId;
  defenderNationId: NationId;
  startedAtFastTick: number;
  lastActiveFastTick: number;
}

export function createBattleId(index: number): BattleId {
  return `battle-${index}` as BattleId;
}

export function updateBattles(world: WorldState): void {
  if (world.wars.length === 0 || world.units.length < 2) {
    return;
  }

  const warAdjacency = buildWarAdjacency(world.wars);
  const existingByKey = indexExistingBattles(world.battles);
  const now = world.time.fastTick;
  const removedUnitIds = new Set<UnitId>();

  const landUnits = world.units.filter((unit) => unit.domain === "land");
  if (landUnits.length >= 2) {
    updateLandBattles(
      world,
      landUnits,
      warAdjacency,
      existingByKey,
      removedUnitIds,
      now,
    );
  }

  const navalUnits = world.units.filter((unit) => unit.domain === "naval");
  if (navalUnits.length >= 2) {
    updateNavalBattles(
      world,
      navalUnits,
      warAdjacency,
      existingByKey,
      removedUnitIds,
      now,
    );
  }

  if (removedUnitIds.size > 0) {
    world.units = world.units.filter((unit) => !removedUnitIds.has(unit.id));
  }

  if (world.battles.length > 0) {
    world.battles = world.battles.filter((battle) => battle.lastActiveFastTick === now);
  }
}

function updateLandBattles(
  world: WorldState,
  landUnits: UnitState[],
  warAdjacency: WarAdjacency,
  existingByKey: Map<string, BattleState>,
  removedUnitIds: Set<UnitId>,
  now: number,
): void {
  const unitsByMesoId = collectUnitsByMesoAndNation(landUnits);
  const attackersByTarget = collectAttackersByTarget(landUnits, unitsByMesoId, warAdjacency);

  for (const [mesoId, attackersByNation] of attackersByTarget.entries()) {
    const defendersByNation = unitsByMesoId.get(mesoId);
    if (!defendersByNation || defendersByNation.size === 0) {
      continue;
    }
    for (const [attackerNation, attackers] of attackersByNation.entries()) {
      for (const [defenderNation, defenders] of defendersByNation.entries()) {
        if (!isAtWar(attackerNation, defenderNation, warAdjacency)) {
          continue;
        }
        const key = battleKey(mesoId, attackerNation, defenderNation);
        let battle = existingByKey.get(key);
        if (!battle) {
          battle = {
            id: createBattleId(world.battles.length),
            mesoId,
            attackerNationId: attackerNation,
            defenderNationId: defenderNation,
            startedAtFastTick: now,
            lastActiveFastTick: now,
          };
          world.battles.push(battle);
          existingByKey.set(key, battle);
          console.info(
            `[Battle] ${battle.mesoId} ${battle.attackerNationId} -> ${battle.defenderNationId} start @${now}`,
          );
        } else {
          battle.lastActiveFastTick = now;
        }

        const outcome = resolveBattle(battle, attackers, defenders, removedUnitIds, now);
        if (outcome) {
          addWarContribution(
            world.wars,
            battle.attackerNationId,
            battle.defenderNationId,
            outcome.defenderManpowerLoss,
          );
          addWarContribution(
            world.wars,
            battle.defenderNationId,
            battle.attackerNationId,
            outcome.attackerManpowerLoss,
          );
        }
      }
    }
  }
}

function updateNavalBattles(
  world: WorldState,
  navalUnits: UnitState[],
  warAdjacency: WarAdjacency,
  existingByKey: Map<string, BattleState>,
  removedUnitIds: Set<UnitId>,
  now: number,
): void {
  const mesoById = getMesoById(world);
  const seaUnits = navalUnits.filter(
    (unit) => mesoById.get(unit.regionId)?.type === "sea",
  );
  if (seaUnits.length < 2) {
    return;
  }

  const unitsByMesoId = collectUnitsByMesoAndNation(seaUnits);
  for (const [mesoId, unitsByNation] of unitsByMesoId.entries()) {
    if (unitsByNation.size < 2) {
      continue;
    }
    const nations = [...unitsByNation.keys()];
    for (let i = 0; i < nations.length; i += 1) {
      for (let j = i + 1; j < nations.length; j += 1) {
        const nationA = nations[i];
        const nationB = nations[j];
        if (!isAtWar(nationA, nationB, warAdjacency)) {
          continue;
        }
        const [attackerNationId, defenderNationId] = normalizeWarPair(nationA, nationB);
        const attackers = unitsByNation.get(attackerNationId);
        const defenders = unitsByNation.get(defenderNationId);
        if (!attackers || !defenders) {
          continue;
        }

        const key = battleKey(mesoId, attackerNationId, defenderNationId);
        let battle = existingByKey.get(key);
        if (!battle) {
          battle = {
            id: createBattleId(world.battles.length),
            mesoId,
            attackerNationId,
            defenderNationId,
            startedAtFastTick: now,
            lastActiveFastTick: now,
          };
          world.battles.push(battle);
          existingByKey.set(key, battle);
          console.info(
            `[Battle] ${battle.mesoId} ${battle.attackerNationId} -> ${battle.defenderNationId} start @${now}`,
          );
        } else {
          battle.lastActiveFastTick = now;
        }

        const outcome = resolveNavalBattle(
          battle,
          attackers,
          defenders,
          removedUnitIds,
          now,
        );
        if (outcome) {
          addWarContribution(
            world.wars,
            battle.attackerNationId,
            battle.defenderNationId,
            outcome.defenderManpowerLoss,
          );
          addWarContribution(
            world.wars,
            battle.defenderNationId,
            battle.attackerNationId,
            outcome.attackerManpowerLoss,
          );
        }
      }
    }
  }
}

function resolveNavalBattle(
  battle: BattleState,
  attackers: UnitState[],
  defenders: UnitState[],
  removedUnitIds: Set<UnitId>,
  now: number,
): { attackerManpowerLoss: number; defenderManpowerLoss: number } | null {
  const combatAttackers = attackers.filter(isCombatShip);
  const combatDefenders = defenders.filter(isCombatShip);
  const transportAttackers = attackers.filter(isTransportShip);
  const transportDefenders = defenders.filter(isTransportShip);

  let attackerManpowerLoss = 0;
  let defenderManpowerLoss = 0;

  if (combatAttackers.length > 0 && combatDefenders.length > 0) {
    const outcome = resolveBattle(
      battle,
      combatAttackers,
      combatDefenders,
      removedUnitIds,
      now,
    );
    if (outcome) {
      attackerManpowerLoss += outcome.attackerManpowerLoss;
      defenderManpowerLoss += outcome.defenderManpowerLoss;
    }
  }

  const remainingCombatAttackers = collectAliveUnits(combatAttackers, removedUnitIds);
  const remainingCombatDefenders = collectAliveUnits(combatDefenders, removedUnitIds);

  if (remainingCombatAttackers.length > 0 && remainingCombatDefenders.length > 0) {
    return attackerManpowerLoss > 0 || defenderManpowerLoss > 0
      ? { attackerManpowerLoss, defenderManpowerLoss }
      : null;
  }

  if (remainingCombatAttackers.length > 0 && transportDefenders.length > 0) {
    const outcome = resolveBattle(
      battle,
      remainingCombatAttackers,
      transportDefenders,
      removedUnitIds,
      now,
    );
    if (outcome) {
      attackerManpowerLoss += outcome.attackerManpowerLoss;
      defenderManpowerLoss += outcome.defenderManpowerLoss;
    }
  }

  if (remainingCombatDefenders.length > 0 && transportAttackers.length > 0) {
    const outcome = resolveBattle(
      battle,
      transportAttackers,
      remainingCombatDefenders,
      removedUnitIds,
      now,
    );
    if (outcome) {
      attackerManpowerLoss += outcome.attackerManpowerLoss;
      defenderManpowerLoss += outcome.defenderManpowerLoss;
    }
  }

  if (attackerManpowerLoss <= 0 && defenderManpowerLoss <= 0) {
    return null;
  }

  return { attackerManpowerLoss, defenderManpowerLoss };
}

function isCombatShip(unit: UnitState): boolean {
  return unit.domain === "naval" && unit.type === "CombatShip";
}

function isTransportShip(unit: UnitState): boolean {
  return unit.domain === "naval" && unit.type === "TransportShip";
}

function collectUnitsByMesoAndNation(
  units: UnitState[],
): Map<MesoRegionId, Map<NationId, UnitState[]>> {
  const unitsByMesoId = new Map<MesoRegionId, Map<NationId, UnitState[]>>();
  for (const unit of units) {
    let byNation = unitsByMesoId.get(unit.regionId);
    if (!byNation) {
      byNation = new Map<NationId, UnitState[]>();
      unitsByMesoId.set(unit.regionId, byNation);
    }
    const list = byNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      byNation.set(unit.nationId, [unit]);
    }
  }
  return unitsByMesoId;
}

function collectAttackersByTarget(
  units: UnitState[],
  unitsByMesoId: Map<MesoRegionId, Map<NationId, UnitState[]>>,
  warAdjacency: WarAdjacency,
): Map<MesoRegionId, Map<NationId, UnitState[]>> {
  const attackersByTarget = new Map<MesoRegionId, Map<NationId, UnitState[]>>();
  for (const unit of units) {
    const targetId = unit.moveToId;
    if (!targetId || targetId === unit.regionId) {
      continue;
    }
    const defendersByNation = unitsByMesoId.get(targetId);
    if (!defendersByNation || defendersByNation.size === 0) {
      continue;
    }
    if (!hasEnemyNation(unit.nationId, defendersByNation, warAdjacency)) {
      continue;
    }
    let attackersByNation = attackersByTarget.get(targetId);
    if (!attackersByNation) {
      attackersByNation = new Map<NationId, UnitState[]>();
      attackersByTarget.set(targetId, attackersByNation);
    }
    const list = attackersByNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      attackersByNation.set(unit.nationId, [unit]);
    }
  }
  return attackersByTarget;
}

function hasEnemyNation(
  nationId: NationId,
  defendersByNation: Map<NationId, UnitState[]>,
  warAdjacency: WarAdjacency,
): boolean {
  for (const defenderNation of defendersByNation.keys()) {
    if (isAtWar(nationId, defenderNation, warAdjacency)) {
      return true;
    }
  }
  return false;
}

function indexExistingBattles(battles: BattleState[]): Map<string, BattleState> {
  const existingByKey = new Map<string, BattleState>();
  for (const battle of battles) {
    existingByKey.set(
      battleKey(battle.mesoId, battle.attackerNationId, battle.defenderNationId),
      battle,
    );
  }
  return existingByKey;
}

function battleKey(
  mesoId: MesoRegionId,
  attackerNationId: NationId,
  defenderNationId: NationId,
): string {
  return `${mesoId}::${attackerNationId}::${defenderNationId}`;
}

const DAMAGE_PER_TICK = 4;
const DAMAGE_SCALE = 10_000;
const ORG_DAMAGE_PER_TICK = 0.5;
const ORG_DAMAGE_SCALE = 10_000;

function resolveBattle(
  battle: BattleState,
  unitsA: UnitState[],
  unitsB: UnitState[],
  removedUnitIds: Set<UnitId>,
  now: number,
): { attackerManpowerLoss: number; defenderManpowerLoss: number } | null {
  const aliveA = collectAliveUnits(unitsA, removedUnitIds);
  const aliveB = collectAliveUnits(unitsB, removedUnitIds);
  if (aliveA.length === 0 || aliveB.length === 0) {
    return null;
  }

  const strengthA = sumStrength(aliveA);
  const strengthB = sumStrength(aliveB);
  if (strengthA <= 0 && strengthB <= 0) {
    return null;
  }

  const damageToA = strengthB > 0 ? DAMAGE_PER_TICK * (strengthB / DAMAGE_SCALE) : 0;
  const damageToB = strengthA > 0 ? DAMAGE_PER_TICK * (strengthA / DAMAGE_SCALE) : 0;
  const orgDamageToA = strengthB > 0 ? ORG_DAMAGE_PER_TICK * (strengthB / ORG_DAMAGE_SCALE) : 0;
  const orgDamageToB = strengthA > 0 ? ORG_DAMAGE_PER_TICK * (strengthA / ORG_DAMAGE_SCALE) : 0;

  const damageWeightA = sumDamageWeight(aliveA);
  const damageWeightB = sumDamageWeight(aliveB);
  const lossA = applyDamage(aliveA, damageWeightA, damageToA, orgDamageToA, removedUnitIds);
  const lossB = applyDamage(aliveB, damageWeightB, damageToB, orgDamageToB, removedUnitIds);

  const remainingA = aliveA.some((unit) => isUnitAlive(unit, removedUnitIds));
  const remainingB = aliveB.some((unit) => isUnitAlive(unit, removedUnitIds));

  if (!remainingA && !remainingB) {
    console.info(
      `[Battle] ${battle.mesoId} ${battle.attackerNationId} -> ${battle.defenderNationId} end (mutual) @${now}`,
    );
  } else if (!remainingA) {
    console.info(
      `[Battle] ${battle.mesoId} ${battle.defenderNationId} holds vs ${battle.attackerNationId} @${now}`,
    );
  } else if (!remainingB) {
    console.info(
      `[Battle] ${battle.mesoId} ${battle.attackerNationId} breaks ${battle.defenderNationId} @${now}`,
    );
  }

  return {
    attackerManpowerLoss: lossA.manpowerLoss,
    defenderManpowerLoss: lossB.manpowerLoss,
  };
}

function collectAliveUnits(
  units: UnitState[],
  removedUnitIds: Set<UnitId>,
): UnitState[] {
  return units.filter((unit) => isUnitAlive(unit, removedUnitIds));
}

function isUnitAlive(unit: UnitState, removedUnitIds: Set<UnitId>): boolean {
  return unit.manpower > 0 && unit.org > 0 && !removedUnitIds.has(unit.id);
}

function sumStrength(units: UnitState[]): number {
  let total = 0;
  for (const unit of units) {
    total += getUnitStrength(unit);
  }
  return total;
}

function sumDamageWeight(units: UnitState[]): number {
  let total = 0;
  for (const unit of units) {
    total += getUnitDamageWeight(unit);
  }
  return total;
}

function getUnitStrength(unit: UnitState): number {
  return getUnitDamageWeight(unit) * Math.max(0, unit.combatPower);
}

function getUnitDamageWeight(unit: UnitState): number {
  const avgFill = getAverageEquipmentFill(unit);
  const orgFactor = 0.5 + unit.org * 0.5;
  const equipmentFactor = 0.5 + avgFill * 0.5;
  return Math.max(0, unit.manpower) * orgFactor * equipmentFactor;
}

function getAverageEquipmentFill(unit: UnitState): number {
  if (unit.equipment.length === 0) {
    return 1;
  }
  let sum = 0;
  for (const slot of unit.equipment) {
    sum += slot.fill;
  }
  return sum / unit.equipment.length;
}

function applyDamage(
  units: UnitState[],
  totalWeight: number,
  manpowerDamage: number,
  orgDamage: number,
  removedUnitIds: Set<UnitId>,
): { manpowerLoss: number; orgLoss: number } {
  if (units.length === 0 || (manpowerDamage <= 0 && orgDamage <= 0)) {
    return { manpowerLoss: 0, orgLoss: 0 };
  }

  let manpowerLoss = 0;
  let orgLoss = 0;
  const useFallback = totalWeight <= 0;
  const fallbackWeight = useFallback ? 1 / units.length : 0;
  for (const unit of units) {
    const weight = useFallback ? fallbackWeight : getUnitDamageWeight(unit) / totalWeight;
    if (!useFallback && weight <= 0) {
      continue;
    }
    const prevManpower = unit.manpower;
    const prevOrg = unit.org;
    if (manpowerDamage > 0) {
      unit.manpower = Math.max(0, unit.manpower - manpowerDamage * weight);
    }
    if (orgDamage > 0) {
      unit.org = Math.max(0, unit.org - orgDamage * weight);
    }
    manpowerLoss += Math.max(0, prevManpower - unit.manpower);
    orgLoss += Math.max(0, prevOrg - unit.org);
    if (unit.manpower <= 0 || unit.org <= 0) {
      removedUnitIds.add(unit.id);
    }
  }

  return { manpowerLoss, orgLoss };
}
