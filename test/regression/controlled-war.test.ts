import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioWorld } from "../scenarios";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";

test("controlled war fixtures establish equal, unequal and scarce starting conditions", () => {
  for (const name of ["matched-war", "unequal-war", "economic-constraint"] as const) {
    const world = createScenarioWorld(name, { seed: 822_748_319_788, width: 640, height: 360, quick: true });
    assert.equal(world.wars.length, 1);
    const war = world.wars[0];
    const power = (id: typeof war.aggressorId) => world.units.filter((unit) => unit.nationId === id)
      .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    assert.equal(power(war.aggressorId) / power(war.defenderId), name === "unequal-war" ? 2 : 1);
    for (const id of [war.aggressorId, war.defenderId]) {
      const nation = world.nations.find((item) => item.id === id)!;
      assert.equal(nation.resources.manpower, name === "economic-constraint" ? 0 : 5000);
      assert.equal(nation.resources.weapons, name === "economic-constraint" ? 0 : 80);
      assert.ok(world.units.filter((unit) => unit.nationId === id).every((unit) => unit.regionId === nation.capitalMesoId));
    }
  }
});
