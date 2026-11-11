import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { createFieldLossObserver } from "../helpers/field-loss-observer";

test("field-loss observation counts damage and later formation removal without changing units", () => {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  const unit = world.units[0];
  world.units = [unit];
  const manpower = unit.manpower;
  const observer = createFieldLossObserver();
  const initial = structuredClone(world.units);
  observer.before(world);
  assert.deepEqual(world.units, initial);
  unit.manpower -= 7;
  const damaged = structuredClone(world.units);
  observer.after(world);
  assert.deepEqual(world.units, damaged);
  observer.before(world);
  world.units = [];
  observer.after(world);
  assert.equal(observer.result()[unit.nationId].unavailableManpower, manpower);
  assert.equal(observer.result()[unit.nationId].survivorManpowerDamage, 7);
});

test("unloading cargo keeps its identity and is not mistaken for a loss", () => {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  const carrier = world.units[0], cargo = world.units[1];
  carrier.cargoUnits = [cargo]; world.units = [carrier];
  const observer = createFieldLossObserver();
  observer.before(world);
  carrier.cargoUnits = []; world.units.push(cargo);
  observer.after(world);
  assert.equal(observer.result()[cargo.nationId].unavailableManpower, 0);
});
