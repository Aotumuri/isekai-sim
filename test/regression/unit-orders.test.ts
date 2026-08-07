import assert from "node:assert/strict";
import test from "node:test";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { runSimulation } from "../helpers/simulation-driver";
import { assertUnitRoleReferences, assertWorldInvariants } from "../helpers/invariants";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createTestScenario } from "../helpers/test-scenario";
import { buildOwnerByMesoId } from "../scenarios/scenario-utils";

test("active-war movement keeps all unit region references valid", () => {
  const world = createTestScenario("active-war");
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 50 }));
  assertWorldInvariants(world);
});

test("the next reposition phase removes stale unit role references", () => {
  const world = createTestScenario("active-war");
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 50 }));

  repositionUnits(world, 0);

  assertUnitRoleReferences(world);
});

test("ending every war clears stale enemy targets", () => {
  const world = createTestScenario("active-war");
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 1 }));
  world.wars = [];
  world.battles = [];
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 1 }));
  const owners = buildOwnerByMesoId(world);

  for (const unit of world.units) {
    if (unit.domain !== "land" || !unit.moveTargetId) {
      continue;
    }
    assert.equal(
      owners.get(unit.moveTargetId),
      unit.nationId,
      `${unit.id} retained a peacetime enemy target`,
    );
  }
});

test("territory ownership change forces target reevaluation", () => {
  const world = createTestScenario("active-war");
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 1 }));
  const attacker = world.units.find((unit) => {
    const targetOwner = unit.moveTargetId ? buildOwnerByMesoId(world).get(unit.moveTargetId) : null;
    return targetOwner && targetOwner !== unit.nationId;
  });
  assert(attacker?.moveTargetId);
  const targetMacro = world.macroRegions.find((macro) =>
    macro.mesoRegionIds.includes(attacker.moveTargetId!),
  );
  const attackerNation = world.nations.find((nation) => nation.id === attacker.nationId);
  const oldOwner = world.nations.find((nation) => nation.id === targetMacro?.nationId);
  assert(targetMacro && attackerNation && oldOwner);
  oldOwner.macroRegionIds = oldOwner.macroRegionIds.filter((id) => id !== targetMacro.id);
  targetMacro.nationId = attacker.nationId;
  attackerNation.macroRegionIds.push(targetMacro.id);
  world.territoryVersion += 1;

  const run = withMutedSimulationLogs(() => runSimulation(world, { ticks: 1 }));
  assert(run.metrics.getCounter("target.reassignments") > 0);
  assertWorldInvariants(world);
});

test("an unreachable sea target is cleared without corrupting movement state", () => {
  const world = createTestScenario("base-world");
  repositionUnits(world, 0);
  const unit = world.units.find((candidate) => candidate.domain === "land");
  const sea = world.mesoRegions.find((meso) => meso.type === "sea");
  assert(unit && sea);
  unit.moveTargetId = sea.id;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;

  repositionUnits(world, 0);

  assert.equal(unit.moveTargetId, null);
  assert.equal(unit.moveFromId, null);
  assert.equal(unit.moveToId, null);
  assert(Number.isFinite(unit.moveProgressMs));
});
