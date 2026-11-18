import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { forecastCampaignForceShares, projectedSurplusFraction } from "../../src/sim/war-campaign/forecast-force";
import { updateLandFronts, getFrontSide, getOpposingFrontSide } from "../../src/sim/land-fronts";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import type { SectorFrontlineCoverage } from "../../src/sim/frontline-coverage";
import { enterPlayerNation } from "../../src/sim/player-nation";
import type { NationReserveState } from "../../src/sim/strategic-reserves";
import type { OffensiveOperation } from "../../src/sim/offensive-operations";

function fixture() {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  updateLandFronts(world);
  const nation = world.wars[0].aggressorId;
  const opponent = world.wars[0].defenderId;
  const units = world.units.filter((u) => u.domain === "land" && u.nationId === nation).slice(0, 2);
  assert.equal(units.length, 2);
  const front = world.landFronts.operationalSectors.find((f) => getFrontSide(f, nation) &&
    getOpposingFrontSide(f, nation)?.nationId === opponent)!;
  assert.ok(front);
  return { world, nation, opponent, units, front };
}

test("cross-theater projection preserves the defense floor without withholding same-opponent strength", () => {
  const { world, nation, opponent, units, front } = fixture();
  const other = world.nations.find((n) => n.id !== nation && n.id !== opponent)!.id;
  const total = units.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  for (const unit of units) world.frontAllocations.frontIdByUnitId.set(unit.id, front.id);
  world.frontlineCoverage.coverageBySectorNation.set(`${front.id}::${nation}`,
    { minimumRequiredStrength: total * 0.75 } as SectorFrontlineCoverage);
  const before = units.map((u) => ({ ...u }));
  const shares = forecastCampaignForceShares(world, nation, other, units);
  assert.ok(Math.abs(units.reduce((sum, u) => sum + shares.get(u.id)! * getUnitCombatStrength(u), 0) - total * 0.25) < 1e-6);
  assert.deepEqual([...forecastCampaignForceShares(world, nation, opponent, units).values()], [1, 1]);
  assert.deepEqual([...shares], [...forecastCampaignForceShares(world, nation, other, units)]);
  assert.deepEqual(units, before);
  assert.equal(projectedSurplusFraction(100, 120), 0);
  assert.equal(projectedSurplusFraction(0, 0), 0);
  assert.equal(projectedSurplusFraction(100, 0), 1);
});

test("reserved, recovering and amphibious force cannot be promised to a new land objective", () => {
  const { world, nation, opponent, units } = fixture();
  const unit = units[0];
  const shares = () => forecastCampaignForceShares(world, nation, opponent, [unit]);
  assert.equal(shares().get(unit.id), 1);
  world.strategicReserves.reserveNationByUnitId.set(unit.id, nation);
  assert.equal(shares().has(unit.id), false);
  world.strategicReserves.reserveNationByUnitId.clear();
  world.amphibiousOperations.capabilityDemandByUnitId.set(unit.id, "reserved" as never);
  assert.equal(shares().has(unit.id), false);
  world.amphibiousOperations.capabilityDemandByUnitId.clear();
  world.retreatPlans.retreatIdByUnitId.set(unit.id, "retreat" as never);
  assert.equal(shares().has(unit.id), false);
  world.retreatPlans.retreatIdByUnitId.clear();
  world.reorganization.planIdByUnitId.set(unit.id, "recovery" as never);
  assert.equal(shares().has(unit.id), false);
});

test("a reserve already reinforcing this opponent remains available until it returns", () => {
  const { world, nation, opponent, units, front } = fixture();
  const unit = units[0];
  const deployment = { targetFrontId: front.id, status: "moving", unitIds: [unit.id] } as NonNullable<NationReserveState["deployment"]>;
  world.strategicReserves.reserveNationByUnitId.set(unit.id, nation);
  world.strategicReserves.reservesByNationId.set(nation, { deployment } as NationReserveState);
  const shares = () => forecastCampaignForceShares(world, nation, opponent, [unit]);
  assert.equal(shares().get(unit.id), 1);
  deployment.status = "returning";
  assert.equal(shares().has(unit.id), false);
});

test("manual orders and another opponent's operation are excluded without cancelling either", () => {
  const { world, nation, opponent, units } = fixture();
  const unit = units[0];
  enterPlayerNation(world, nation);
  world.playerNation!.landOrders.set(unit.id, unit.regionId);
  const shares = () => forecastCampaignForceShares(world, nation, opponent, [unit]);
  assert.equal(shares().has(unit.id), false);
  assert.equal(world.playerNation!.landOrders.get(unit.id), unit.regionId);
  world.playerNation!.landOrders.clear();
  const other = world.nations.find((n) => n.id !== nation && n.id !== opponent)!.id;
  const operation = { id: "committed", enemyNationId: other } as OffensiveOperation;
  world.offensiveOperations.operations.push(operation);
  world.offensiveOperations.operationIdByUnitId.set(unit.id, operation.id);
  assert.equal(shares().has(unit.id), false);
  operation.enemyNationId = opponent;
  assert.equal(shares().get(unit.id), 1);
  assert.equal(world.offensiveOperations.operationIdByUnitId.get(unit.id), operation.id);
});
