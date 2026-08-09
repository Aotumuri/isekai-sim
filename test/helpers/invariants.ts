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
  for (const assessment of world.capitalDefense.assessments) {
    assert(nationIds.has(assessment.nationId), "capital defense nation is missing");
    assert(
      mesoIds.has(assessment.capitalRegionId),
      `${assessment.nationId} capital defense target is missing`,
    );
    for (const regionId of assessment.defenseRegionIds) {
      assert(mesoIds.has(regionId), `${assessment.nationId} defense region is missing`);
    }
    for (const value of [
      assessment.friendlyStrength,
      assessment.enemyStrength,
      assessment.frontEnemyStrength,
      assessment.nationalLandStrength,
      assessment.minimumDefenseStrength,
      assessment.evaluatedAtTick,
    ]) {
      assert(
        Number.isFinite(value),
        `${assessment.nationId} capital defense numeric state must be finite`,
      );
    }
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
    if (operation.exploitationTargetRegionId) {
      assert(
        mesoIds.has(operation.exploitationTargetRegionId),
        `${operation.id} exploitation target is missing`,
      );
    }
    const exploitationIds = new Set(operation.exploitationUnitIds);
    const holdIds = new Set(operation.exploitationHoldUnitIds);
    for (const unitId of exploitationIds) {
      assert(operation.assignedUnitIds.includes(unitId), `${operation.id} exploitation unit is unassigned`);
      assert(!holdIds.has(unitId), `${operation.id} exploitation and hold forces overlap`);
    }
    for (const unitId of holdIds) {
      assert(operation.assignedUnitIds.includes(unitId), `${operation.id} hold unit is unassigned`);
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
  const reserveNationIds = new Set<string>();
  const reserveUnitIds = new Set<string>();
  for (const reserve of world.strategicReserves.reserves) {
    assert(
      nationIds.has(reserve.nationId),
      `${reserve.nationId} reserve nation is missing`,
    );
    assert(
      !reserveNationIds.has(reserve.nationId),
      `${reserve.nationId} has multiple reserve states`,
    );
    reserveNationIds.add(reserve.nationId);
    for (const regionId of reserve.stagingRegionIds) {
      const region = world.mesoRegions.find((candidate) => candidate.id === regionId);
      assert(region && region.type !== "sea", `${reserve.nationId} staging is invalid`);
    }
    for (const unitId of reserve.unitIds) {
      const unit = world.units.find((candidate) => candidate.id === unitId);
      assert(unit, `${reserve.nationId} reserve references missing ${unitId}`);
      assert.equal(unit.domain, "land", `${unitId} reserve unit must be land`);
      assert.equal(unit.nationId, reserve.nationId, `${unitId} reserve owner differs`);
      assert(!reserveUnitIds.has(unitId), `${unitId} belongs to multiple reserves`);
      assert(
        !world.frontAllocations.frontIdByUnitId.has(unitId),
        `${unitId} belongs to reserve and Front allocation`,
      );
      assert(
        !world.offensiveOperations.operationIdByUnitId.has(unitId),
        `${unitId} belongs to reserve and offensive operation`,
      );
      assert(
        !world.retreatPlans.retreatIdByUnitId.has(unitId),
        `${unitId} belongs to reserve and retreat`,
      );
      reserveUnitIds.add(unitId);
    }
    if (reserve.deployment) {
      for (const regionId of reserve.deployment.targetRegionIds) {
        const region = world.mesoRegions.find((candidate) => candidate.id === regionId);
        assert(region && region.type !== "sea", `${reserve.nationId} deployment target is invalid`);
      }
      for (const unitId of reserve.deployment.unitIds) {
        assert(
          reserveUnitIds.has(unitId),
          `${unitId} deployment unit is not a reserve member`,
        );
      }
      for (const [unitId, regionId] of reserve.deployment.unitTargetRegionIds) {
        assert(
          reserve.deployment.unitIds.includes(unitId),
          `${unitId} has a target outside its deployment`,
        );
        assert(mesoIds.has(regionId), `${unitId} reserve target is invalid`);
      }
      for (const value of [
        reserve.deployment.startedAtTick,
        reserve.deployment.initialTargetDeficit,
        reserve.deployment.lastEffectiveDeficit,
        reserve.deployment.lastArrivedUnitCount,
      ]) {
        assert(Number.isFinite(value), `${reserve.nationId} deployment numeric state must be finite`);
      }
    }
    for (const value of [
      reserve.totalStrength,
      reserve.desiredReserveStrength,
      reserve.cooldownUntilTick,
    ]) {
      assert(Number.isFinite(value), `${reserve.nationId} reserve numeric state must be finite`);
    }
  }
  assert.equal(
    world.strategicReserves.reserveNationByUnitId.size,
    reserveUnitIds.size,
    "reserve membership index must match reserve states",
  );
  const reorganizationIds = new Set<string>();
  const reorganizationUnitIds = new Set<string>();
  for (const plan of world.reorganization.plans) {
    assert(!reorganizationIds.has(plan.id), `${plan.id} must be unique`);
    reorganizationIds.add(plan.id);
    assert(nationIds.has(plan.nationId), `${plan.id} nation is missing`);
    assert(unitIds.has(plan.unitId), `${plan.id} unit is missing`);
    assert(mesoIds.has(plan.locationRegionId), `${plan.id} rear region is missing`);
    const unit = world.units.find((candidate) => candidate.id === plan.unitId);
    assert(unit && unit.domain === "land", `${plan.id} must reference a land unit`);
    assert.equal(unit.nationId, plan.nationId, `${plan.id} unit owner differs`);
    assert(
      !reorganizationUnitIds.has(plan.unitId),
      `${plan.unitId} belongs to multiple reorganization plans`,
    );
    assert(
      !world.frontAllocations.frontIdByUnitId.has(plan.unitId),
      `${plan.unitId} belongs to Reorganization and Front allocation`,
    );
    assert(
      !world.offensiveOperations.operationIdByUnitId.has(plan.unitId),
      `${plan.unitId} belongs to Reorganization and Offensive Operation`,
    );
    assert(
      !world.retreatPlans.retreatIdByUnitId.has(plan.unitId),
      `${plan.unitId} belongs to Reorganization and Retreat`,
    );
    assert(
      !world.strategicReserves.reserveNationByUnitId.has(plan.unitId),
      `${plan.unitId} belongs to Reorganization and Strategic Reserve`,
    );
    for (const value of [
      plan.startedAtTick,
      plan.phaseStartedAtTick,
      plan.targetTerritoryVersion,
      plan.targetOccupationVersion,
      plan.targetFrontVersion,
      plan.initialManpowerRatio,
      plan.initialEquipmentRatio,
      plan.initialOrganizationRatio,
      plan.organizationRecovered,
      plan.manpowerReinforced,
      plan.equipmentReinforced,
      plan.manpowerResourceConsumed,
      plan.equipmentStockConsumed,
      plan.interruptionCount,
    ]) {
      assert(Number.isFinite(value), `${plan.id} numeric state must be finite`);
    }
    for (const value of plan.equipmentTargetRatioByKey.values()) {
      assert(Number.isFinite(value), `${plan.id} equipment target must be finite`);
    }
    reorganizationUnitIds.add(plan.unitId);
  }
  assert.equal(
    world.reorganization.planIdByUnitId.size,
    reorganizationUnitIds.size,
    "reorganization membership index must match active plans",
  );
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
      exploitationTarget: operation.exploitationTargetRegionId,
      exploitationCoverage: operation.exploitationTargetCoverageState,
      exploitationLocalDefense: operation.exploitationTargetLocalEnemyStrength,
      exploitationScore: operation.exploitationTargetScore,
      exploitationDepth: operation.exploitationDepth,
      exploitationUnits: [...operation.exploitationUnitIds],
      exploitationHoldUnits: [...operation.exploitationHoldUnitIds],
      exploitationForceStrength: operation.exploitationForceStrength,
      exploitationStopReason: operation.exploitationStopReason,
      capturedRegions: [...operation.capturedRegionIds],
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
    capitalDefense: world.capitalDefense.assessments.map((assessment) => ({
      nation: assessment.nationId,
      capital: assessment.capitalRegionId,
      regions: [...assessment.defenseRegionIds],
      fronts: [...assessment.threatenedFrontIds],
      primary: assessment.primaryFrontId,
      level: assessment.threatLevel,
      friendly: assessment.friendlyStrength,
      enemy: assessment.enemyStrength,
      minimum: assessment.minimumDefenseStrength,
      started: assessment.emergencyStartedAtTick,
    })),
    strategicReserves: world.strategicReserves.reserves.map((reserve) => ({
      nation: reserve.nationId,
      units: [...reserve.unitIds],
      strength: reserve.totalStrength,
      desired: reserve.desiredReserveStrength,
      staging: [...reserve.stagingRegionIds],
      status: reserve.status,
      deployment: reserve.deployment
        ? {
            type: reserve.deployment.targetType,
            front: reserve.deployment.targetFrontId,
            targets: [...reserve.deployment.targetRegionIds],
            units: [...reserve.deployment.unitIds],
            unitTargets: [...reserve.deployment.unitTargetRegionIds.entries()],
            status: reserve.deployment.status,
            reasons: [...reserve.deployment.reasonFlags],
          }
        : null,
    })),
    reorganization: world.reorganization.plans.map((plan) => ({
      id: plan.id,
      nation: plan.nationId,
      unit: plan.unitId,
      location: plan.locationRegionId,
      phase: plan.phase,
      started: plan.startedAtTick,
      phaseStarted: plan.phaseStartedAtTick,
      initial: [
        plan.initialOrganizationRatio,
        plan.initialManpowerRatio,
        plan.initialEquipmentRatio,
      ],
      reasons: [...plan.reasonFlags],
      recovered: [
        plan.organizationRecovered,
        plan.manpowerReinforced,
        plan.equipmentReinforced,
      ],
      outcome: plan.outcome,
    })),
  };
}
