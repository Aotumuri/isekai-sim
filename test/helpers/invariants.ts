import assert from "node:assert/strict";
import type { WorldState } from "../../src/sim/world-state";

export function assertWorldInvariants(world: WorldState): void {
  const nationIds = new Set(world.nations.map((nation) => nation.id));
  const mesoIds = new Set(world.mesoRegions.map((meso) => meso.id));
  const macroById = new Map(world.macroRegions.map((macro) => [macro.id, macro]));
  const unitIds = new Set(world.units.map((unit) => unit.id));

  assert.equal(nationIds.size, world.nations.length, "nation IDs must be unique");
  assert.equal(mesoIds.size, world.mesoRegions.length, "meso IDs must be unique");
  assert.equal(unitIds.size, world.units.length, "unit IDs must be unique");

  for (const macro of world.macroRegions) {
    assert(nationIds.has(macro.nationId), `${macro.id} references a missing nation`);
    for (const mesoId of macro.mesoRegionIds) {
      assert(mesoIds.has(mesoId), `${macro.id} references missing ${mesoId}`);
    }
  }
  for (const nation of world.nations) {
    assert(mesoIds.has(nation.capitalMesoId), `${nation.id} has a missing capital`);
    for (const macroId of nation.macroRegionIds) {
      const macro = macroById.get(macroId);
      assert(macro, `${nation.id} references missing ${macroId}`);
      assert.equal(macro.nationId, nation.id, `${macroId} owner disagrees with nation`);
    }
    for (const [resource, value] of Object.entries(nation.resources)) {
      assert(Number.isFinite(value), `${nation.id}.${resource} must be finite`);
    }
    for (const group of [nation.resourceFlow.income, nation.resourceFlow.usage, nation.resourceFlow.delta]) {
      for (const [resource, value] of Object.entries(group)) {
        assert(Number.isFinite(value), `${nation.id}.resourceFlow.${resource} must be finite`);
      }
    }
  }

  for (const unit of world.units) {
    assert(nationIds.has(unit.nationId), `${unit.id} references a missing nation`);
    assert(mesoIds.has(unit.regionId), `${unit.id} is in a missing region`);
    for (const [label, regionId] of [
      ["target", unit.moveTargetId],
      ["from", unit.moveFromId],
      ["to", unit.moveToId],
    ] as const) {
      assert(!regionId || mesoIds.has(regionId), `${unit.id} ${label} is invalid`);
    }
    for (const [field, value] of [
      ["moveProgressMs", unit.moveProgressMs],
      ["combatPower", unit.combatPower],
      ["org", unit.org],
      ["manpower", unit.manpower],
    ] as const) {
      assert(Number.isFinite(value), `${unit.id}.${field} must be finite`);
    }
    // Production intentionally uses +Infinity to immobilize units without supplies.
    assert(!Number.isNaN(unit.moveTicksPerRegion) && unit.moveTicksPerRegion > 0);
    for (const slot of unit.equipment) {
      assert(Number.isFinite(slot.fill), `${unit.id} equipment fill must be finite`);
    }
  }

  for (const war of world.wars) {
    assert(nationIds.has(war.nationAId), `${war.id} nation A is missing`);
    assert(nationIds.has(war.nationBId), `${war.id} nation B is missing`);
  }
  for (const battle of world.battles) {
    assert(mesoIds.has(battle.mesoId), `${battle.id} region is missing`);
    assert(nationIds.has(battle.attackerNationId), `${battle.id} attacker is missing`);
    assert(nationIds.has(battle.defenderNationId), `${battle.id} defender is missing`);
  }
  for (const [mesoId, occupier] of world.occupation.mesoById) {
    assert(mesoIds.has(mesoId), `occupation references missing ${mesoId}`);
    assert(nationIds.has(occupier), `occupation references missing ${occupier}`);
  }
  const operationIds = new Set(
    world.offensiveOperations.operations.map((operation) => operation.id),
  );
  assert.equal(
    operationIds.size,
    world.offensiveOperations.operations.length,
    "operation IDs must be unique",
  );
  for (const operation of world.offensiveOperations.operations) {
    assert(nationIds.has(operation.nationId), `${operation.id} nation is missing`);
    assert(
      mesoIds.has(operation.primaryTargetRegionId),
      `${operation.id} primary target is missing`,
    );
    assert(
      mesoIds.has(operation.stagingRegionId),
      `${operation.id} staging region is missing`,
    );
    for (const targetId of operation.supportingTargetRegionIds) {
      assert(mesoIds.has(targetId), `${operation.id} supporting target is missing`);
    }
  }
  const retreatIds = new Set(world.retreatPlans.plans.map((retreat) => retreat.id));
  assert.equal(
    retreatIds.size,
    world.retreatPlans.plans.length,
    "retreat plan IDs must be unique",
  );
  const retreatUnitIds = new Set<string>();
  for (const retreat of world.retreatPlans.plans) {
    assert(nationIds.has(retreat.nationId), `${retreat.id} nation is missing`);
    assert(nationIds.has(retreat.enemyNationId), `${retreat.id} enemy is missing`);
    for (const fallbackId of retreat.fallbackRegionIds) {
      assert(mesoIds.has(fallbackId), `${retreat.id} fallback is missing`);
    }
    const rearguardIds = new Set(retreat.rearguardUnitIds);
    for (const unitId of retreat.retreatingUnitIds) {
      assert(!rearguardIds.has(unitId), `${retreat.id} force groups overlap`);
    }
    for (const unitId of [
      ...retreat.rearguardUnitIds,
      ...retreat.retreatingUnitIds,
    ]) {
      assert(unitIds.has(unitId), `${retreat.id} references missing ${unitId}`);
      assert(!retreatUnitIds.has(unitId), `${unitId} belongs to multiple retreats`);
      assert(
        !world.offensiveOperations.operationIdByUnitId.has(unitId),
        `${unitId} belongs to a retreat and offensive operation`,
      );
      retreatUnitIds.add(unitId);
    }
    const initialRearguardIds = new Set(retreat.initialRearguardUnitIds);
    assert(
      retreat.initialRetreatingUnitIds.every(
        (unitId) => !initialRearguardIds.has(unitId),
      ),
      `${retreat.id} initial force groups overlap`,
    );
    for (const value of [
      retreat.createdAtTick,
      retreat.startedAtTick,
      retreat.phaseStartedAtTick,
      retreat.initialUnitCount,
      retreat.initialRearguardUnitCount,
      retreat.initialRetreatingUnitCount,
      retreat.initialFriendlyStrength,
      retreat.initialEnemyStrength,
      retreat.initialRearguardStrength,
      retreat.initialRetreatingStrength,
      retreat.currentRetreatingStrength,
      retreat.arrivedUnitCount,
      retreat.arrivedStrength,
    ]) {
      assert(Number.isFinite(value), `${retreat.id} numeric state must be finite`);
    }
  }
}

export function assertUnitRoleReferences(world: WorldState): void {
  const unitIds = new Set(world.units.map((unit) => unit.id));
  for (const nation of world.nations) {
    for (const unitId of [
      ...nation.unitRoles.defenseUnitIds,
      ...nation.unitRoles.occupationUnitIds,
    ]) {
      assert(unitIds.has(unitId), `${nation.id} role references missing ${unitId}`);
    }
  }
}

export function semanticWorldSignature(world: WorldState): unknown {
  return {
    time: { ...world.time },
    versions: [world.territoryVersion, world.occupation.version, world.buildingVersion],
    nations: world.nations.map((nation) => ({
      id: nation.id,
      capital: nation.capitalMesoId,
      macros: [...nation.macroRegionIds],
      resources: { ...nation.resources },
    })),
    units: world.units.map((unit) => ({
      id: unit.id,
      nation: unit.nationId,
      region: unit.regionId,
      target: unit.moveTargetId,
      from: unit.moveFromId,
      to: unit.moveToId,
      progress: unit.moveProgressMs,
      manpower: unit.manpower,
      org: unit.org,
    })),
    wars: world.wars.map((war) => [war.nationAId, war.nationBId]),
    battles: world.battles.map((battle) => [
      battle.mesoId,
      battle.attackerNationId,
      battle.defenderNationId,
    ]),
    occupation: [...world.occupation.mesoById.entries()],
    offensiveOperations: world.offensiveOperations.operations.map((operation) => ({
      id: operation.id,
      nation: operation.nationId,
      front: operation.frontId,
      phase: operation.phase,
      primary: operation.primaryTargetRegionId,
      supporting: [...operation.supportingTargetRegionIds],
      staging: operation.stagingRegionId,
      units: [...operation.assignedUnitIds],
      targets: [...operation.unitTargetRegionIds.entries()],
      outcome: operation.outcome,
      reason: operation.completionReason,
    })),
    retreatPlans: world.retreatPlans.plans.map((retreat) => ({
      id: retreat.id,
      nation: retreat.nationId,
      enemy: retreat.enemyNationId,
      front: retreat.frontId,
      phase: retreat.phase,
      rearguard: [...retreat.rearguardUnitIds],
      withdrawing: [...retreat.retreatingUnitIds],
      fallback: [...retreat.fallbackRegionIds],
      targets: [...retreat.unitTargetRegionIds.entries()],
      arrived: retreat.arrivedUnitCount,
      outcome: retreat.outcome,
      reason: retreat.completionReason,
    })),
  };
}
