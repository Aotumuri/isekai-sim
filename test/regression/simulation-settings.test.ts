import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationSettings, getWarDeclarationMode } from "../../src/sim/simulation-settings";
import { getNationCharacter } from "../../src/sim/nation-character";
import { updateWarDeclarations } from "../../src/sim/war-declaration";
import { createSocietyWorld } from "../helpers/society-world";

test("diplomacy overrides the legacy declaration scheduler and can be switched off", () => {
  const world = createSocietyWorld();
  for (const nation of world.nations) nation.nextWarDeclarationTick = 0;
  assert.equal(getWarDeclarationMode(world), "diplomacy");
  updateWarDeclarations(world);
  assert(world.nations.every((nation) => nation.nextWarDeclarationTick === 0));
  world.settings!.diplomacyEnabled = false;
  assert.equal(getWarDeclarationMode(world), "legacy");
  world.settings!.legacyWarDeclarationsEnabled = false;
  assert.equal(getWarDeclarationMode(world), "off");
  assert.equal(createSimulationSettings().researchEnabled, true);
});

test("national characters are deterministic and do not consume the simulation RNG", () => {
  const first = createSocietyWorld();
  const second = createSocietyWorld();
  const expected = first.nations.map((nation) => getNationCharacter(first, nation.id));
  second.nations.reverse();
  for (const nation of second.nations) assert.deepEqual(getNationCharacter(second, nation.id),
    expected[first.nations.findIndex((item) => item.id === nation.id)]);
  assert.equal(first.simRng.nextFloat(), second.simRng.nextFloat());
  assert(new Set(expected.map((character) => character.doctrine)).size > 1);
});
