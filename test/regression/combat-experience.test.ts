import assert from "node:assert/strict";
import test from "node:test";
import { createBattleId, resolveBattle, type BattleState } from "../../src/sim/battles";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { createMesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";

test("combat survivors earn bounded experience and hit harder", () => {
  const region = createMesoRegionId(0);
  const attacker = createUnitForType(createUnitId(0), "nation-a" as NationId, region, "Infantry");
  const defender = createUnitForType(createUnitId(1), "nation-b" as NationId, region, "Infantry");
  attacker.combatExperience = 99.9;
  const battle: BattleState = {
    id: createBattleId(0), mesoId: region, attackerNationId: attacker.nationId, defenderNationId: defender.nationId,
    startedAtFastTick: 0, lastActiveFastTick: 0, attackDirectionCount: 1,
    attackSourceRegionIds: [], attackStrengthBySourceRegion: new Map(), multiDirectionModifier: 1,
    attackerOrganizationLoss: 0, defenderOrganizationLoss: 0, attackerManpowerLoss: 0, defenderManpowerLoss: 0,
  };
  assert(resolveBattle(battle, [attacker], [defender], new Set(), 0));
  assert.equal(attacker.combatExperience, 100);
  assert.equal(defender.combatExperience, 0.25);
  assert(getUnitCombatStrength(attacker) > getUnitCombatStrength({ ...attacker, combatExperience: undefined }) * 1.149);
});
