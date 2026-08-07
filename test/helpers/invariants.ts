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
  };
}
