import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation, hasTreaty } from "../../src/sim/diplomacy";
import { concludePeace, getWarFatigue, mediateCrisis, updateDiplomaticPeace } from "../../src/sim/diplomatic-peace";
import { declareWar, findWar } from "../../src/sim/war-state";
import { createSocietyWorld } from "../helpers/society-world";
import { createScenarioWorld } from "../scenarios";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

test("negotiated peace returns occupations and troops while preserving unrelated wars", () => {
  const world = createSocietyWorld();
  const [a, b, c] = world.nations.slice(0, 3);
  assert(a && b && c);
  declareWar(world.wars, a.id, b.id, 0);
  declareWar(world.wars, a.id, c.id, 0);
  const unit = world.units.find((item) => item.nationId === a.id)!;
  unit.regionId = b.capitalMesoId; unit.moveToId = b.capitalMesoId;
  world.occupation.mesoById.set(b.capitalMesoId, a.id);
  world.occupation.version += 1;
  assert(concludePeace(world, a.id, b.id));
  assert.equal(findWar(world.wars, a.id, b.id), null);
  assert(findWar(world.wars, a.id, c.id));
  assert.equal(world.occupation.mesoById.has(b.capitalMesoId), false);
  assert.equal(unit.regionId, a.capitalMesoId);
  assert.equal(unit.moveToId, null);
  assert(hasTreaty(world, a.id, b.id, "truce"));
  const newWar = declareWar(world.wars, b.id, c.id, 20)!;
  assert.equal(new Set(world.wars.map((war) => war.id)).size, world.wars.length);
  assert.notEqual(newWar.id, world.wars[0]!.id);
});

test("war fatigue updates once per interval and trusted third parties can mediate", () => {
  const world = createSocietyWorld();
  const [a, b, c] = world.nations.slice(0, 3);
  assert(a && b && c);
  declareWar(world.wars, a.id, b.id, 0);
  updateDiplomaticPeace(world);
  const fatigue = getWarFatigue(world, a.id, b.id);
  updateDiplomaticPeace(world);
  assert.equal(getWarFatigue(world, a.id, b.id), fatigue);
  concludePeace(world, a.id, b.id);
  const relation = getRelation(world, a.id, b.id);
  relation.treaties = [];
  relation.crisis = { aggressorId: a.id, openedAtSlowTick: 0, deadlineSlowTick: 30, demand: "concessions" };
  getRelation(world, c.id, a.id).trust = 70;
  getRelation(world, c.id, b.id).trust = 70;
  assert(mediateCrisis(world, c.id, a.id, b.id));
  assert.equal(relation.crisis, null);
  assert(getDiplomacyState(world).crisesResolved > 0);
});

test("peace rescues troops embarked at sea without counting a failed landing", () => {
  const world = createScenarioWorld("two-island-amphibious", { seed: 695919685365, width: 640, height: 360, quick: true });
  world.settings = createSimulationSettings({ researchEnabled: false, mobilizationEnabled: false });
  const sea = new Set(world.mesoRegions.filter((region) => region.type === "sea").map((region) => region.id));
  withMutedSimulationLogs(() => {
    for (let i = 0; i < 600 && !world.units.some((unit) => sea.has(unit.regionId) && unit.cargoUnits.length > 0); i += 1) {
      stepFastTick(world, 100);
      if (world.time.fastTick % 10 === 0) stepSlowTick(world, 1000);
    }
  });
  const transport = world.units.find((unit) => sea.has(unit.regionId) && unit.cargoUnits.length > 0);
  assert(transport);
  const cargoIds = transport.cargoUnits.map((unit) => unit.id);
  const failures = world.amphibiousOperations.failedLandings;
  assert(concludePeace(world, world.nations[0]!.id, world.nations[1]!.id));
  assert.equal(transport.cargoUnits.length, 0);
  for (const id of cargoIds) assert.equal(world.units.filter((unit) => unit.id === id).length, 1);
  assert.equal(world.amphibiousOperations.failedLandings, failures);
});
