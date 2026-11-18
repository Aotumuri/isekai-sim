import assert from "node:assert/strict";
import test from "node:test";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { createCapitalFrontExecutionObserver } from "../helpers/capital-front-execution";
import { createTestScenario } from "../helpers/test-scenario";

test("capital observation distinguishes movement, transport and missing units with bounded history", () => {
  const world = createTestScenario("matched-war");
  const nation = world.nations.find((item) => item.id === world.wars[0].defenderId)!;
  const capital = nation.capitalMesoId;
  const tracked = Array.from({ length: 3 }, () =>
    createUnitForType(createUnitId(world.unitIdCounter++), nation.id, capital, "Infantry"));
  const [moved, transported, missing] = tracked;
  const ship = createUnitForType(createUnitId(world.unitIdCounter++), nation.id, capital, "TransportShip");
  world.units = [...tracked, ship];
  const trace = createCapitalFrontExecutionObserver(nation.id, capital, 10);
  const capped = createCapitalFrontExecutionObserver(nation.id, capital, 1);
  for (const observer of [trace, capped]) observer.observe(world);

  moved.regionId = world.nations.find((item) => item.id !== nation.id)!.capitalMesoId;
  world.units = [moved, ship];
  ship.cargoUnits.push(transported);
  world.time.fastTick++;
  for (const observer of [trace, capped]) {
    observer.observe(world);
    observer.observe(world);
  }

  const events = trace.result().events.filter((event) => event.kind === "unit").filter((event) => event.tick === 1);
  assert.deepEqual(events.map(({ id, presence }) => [id, presence]), [
    [moved.id, "field"], [transported.id, "transport"], [missing.id, "not-observed"],
  ]);
  assert.equal(events[0].after?.regionId, moved.regionId);
  assert.equal(events[1].before?.regionId, capital);
  assert.equal(capped.result().events.length, 1);
  assert.equal(capped.result().omittedEvents, trace.result().events.length - 1);
  assert.equal(capped.result().samples, 2);
  assert.equal(capped.result().ticksByState.inactive, 1);
});
