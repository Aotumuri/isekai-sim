import assert from "node:assert/strict";
import test from "node:test";
import {
  getMultiDirectionModifier,
  resolveBattle,
  summarizeAttackDirections,
  type BattleState,
} from "../../src/sim/battles";
import { createWorldCache } from "../../src/sim/world-cache";
import { createOccupationState } from "../../src/sim/occupation";
import {
  getApproachReadiness,
  planOperationApproaches,
  type OffensiveOperation,
  type OperationTargetSelection,
} from "../../src/sim/offensive-operations";
import type { WorldState } from "../../src/sim/world-state";
import type { UnitState } from "../../src/sim/unit";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";

const A = "nation-a" as NationId;
const B = "nation-b" as NationId;
const TARGET = id("target");
const SOURCES = [id("a"), id("b"), id("c"), id("d")];

test("attack directions use distinct adjacent participating land sources", () => {
  const world = directionWorld();
  const sameSource = [unit("a1", SOURCES[0]), unit("a2", SOURCES[0])];
  assert.equal(summarizeAttackDirections(world, TARGET, sameSource).directionCount, 1);
  assert.equal(
    summarizeAttackDirections(world, TARGET, [...sameSource, unit("b1", SOURCES[1])]).directionCount,
    2,
  );
  assert.equal(
    summarizeAttackDirections(world, TARGET, [
      unit("a1", SOURCES[0]), unit("b1", SOURCES[1]), unit("c1", SOURCES[2]),
    ]).directionCount,
    3,
  );
});

test("naval, stale, non-participating, and non-adjacent units are excluded", () => {
  const world = directionWorld();
  const naval = unit("naval", SOURCES[1], "naval");
  const stale = unit("stale", SOURCES[2]);
  stale.moveToId = id("elsewhere");
  const nonAdjacent = unit("far", id("far"));
  const summary = summarizeAttackDirections(world, TARGET, [
    unit("valid", SOURCES[0]), naval, stale, nonAdjacent,
  ]);
  assert.deepEqual(summary.sourceRegionIds, [SOURCES[0]]);
});

test("a token secondary force does not create fake flanking", () => {
  const world = directionWorld();
  const token = unit("token", SOURCES[1]);
  token.manpower = 100;
  const summary = summarizeAttackDirections(world, TARGET, [unit("main", SOURCES[0]), token]);
  assert.equal(summary.directionCount, 1);
  assert.equal(summary.modifier, 1);
});

test("configured modifiers grow from two to three directions and cap", () => {
  assert.equal(getMultiDirectionModifier(1), 1);
  assert(getMultiDirectionModifier(2) > 1);
  assert(getMultiDirectionModifier(3) > getMultiDirectionModifier(2));
  assert.equal(getMultiDirectionModifier(20), 1.3);
});

test("controlled equal-strength battle adds organization pressure without manpower inflation", () => {
  const baseline = resolveOnce(1);
  const two = resolveOnce(2);
  const three = resolveOnce(3);
  assert.equal(two.defenderManpowerLoss, baseline.defenderManpowerLoss);
  assert.equal(three.defenderManpowerLoss, baseline.defenderManpowerLoss);
  assert.equal(two.attackerOrganizationLoss, baseline.attackerOrganizationLoss);
  assert(two.defenderOrganizationLoss > baseline.defenderOrganizationLoss);
  assert(three.defenderOrganizationLoss > two.defenderOrganizationLoss);
  assert(Math.abs(two.defenderOrganizationLoss / baseline.defenderOrganizationLoss - 1.12) < 1e-9);
  assert(Math.abs(three.defenderOrganizationLoss / baseline.defenderOrganizationLoss - 1.24) < 1e-9);
});

test("controlled repeated battle collapses organization faster with more directions", () => {
  const one = resolveToCompletion(1);
  const two = resolveToCompletion(2);
  const three = resolveToCompletion(3);
  assert.equal(one.winner, "attacker");
  assert.equal(two.winner, "attacker");
  assert.equal(three.winner, "attacker");
  assert(two.durationTicks < one.durationTicks);
  assert(three.durationTicks < two.durationTicks);
  assert(two.defenderManpowerLoss < one.defenderManpowerLoss);
  assert(three.defenderManpowerLoss < two.defenderManpowerLoss);
});

test("AI plans two meaningful nearby approaches and rejects a huge detour", () => {
  const world = approachWorld();
  const units = [unit("u1", SOURCES[0]), unit("u2", SOURCES[0]), unit("u3", SOURCES[1]), unit("u4", SOURCES[1])];
  world.units = units;
  const plan = planOperationApproaches(world, A, targetSelection("weak", 2_000), units, false);
  assert.deepEqual(plan.regionIds, [SOURCES[0], SOURCES[1]]);
  assert(!plan.regionIds.includes(SOURCES[3]));
  assert([...plan.strengthByRegion.values()].every((strength) => strength >= 1_000));
});

test("AI uses one approach when only one is viable or a gap should be taken immediately", () => {
  const world = approachWorld();
  const units = [unit("u1", SOURCES[0]), unit("u2", SOURCES[0]), unit("u3", SOURCES[1]), unit("u4", SOURCES[1])];
  world.mesoRegions.find((region) => region.id === TARGET)!.neighbors = [{ id: SOURCES[0], hasRiver: false }];
  world.cache = createWorldCache();
  assert.equal(planOperationApproaches(world, A, targetSelection("weak", 2_000), units, false).regionIds.length, 1);
  const gapWorld = approachWorld();
  assert.equal(planOperationApproaches(gapWorld, A, targetSelection("gap", 0), units, true).regionIds.length, 1);
});

test("Approach readiness uses the same staging radius as preparation", () => {
  const world = approachWorld();
  const units = [unit("u1", SOURCES[0]), unit("u2", SOURCES[0]), unit("u3", SOURCES[0]), unit("u4", SOURCES[1])];
  world.units = units;
  const operation = {
    assignedUnitIds: units.map((item) => item.id),
    plannedApproachRegionIds: [SOURCES[0], SOURCES[1]],
    approachRegionByUnitId: new Map(units.map((item, index) => [item.id, index < 2 ? SOURCES[0] : SOURCES[1]])),
    plannedStrengthByApproach: new Map([[SOURCES[0], 2_000], [SOURCES[1], 2_000]]),
  } as OffensiveOperation;
  const withinApproachRadius = getApproachReadiness(world, operation);
  assert.equal(withinApproachRadius.readyCount, 2);
  assert.equal(withinApproachRadius.ready, true);
  assert.equal(withinApproachRadius.operationCompletion, 1);
  units[2].regionId = SOURCES[1];
  const ready = getApproachReadiness(world, operation);
  assert.equal(ready.readyCount, 2);
  assert.equal(ready.ready, true);
});

function resolveOnce(directionCount: number) {
  const attackers = Array.from({ length: 6 }, (_, index) => unit(`attacker-${index}`, SOURCES[index % directionCount]));
  const defenders = Array.from({ length: 4 }, (_, index) => unit(`defender-${index}`, TARGET, "land", B));
  for (const defender of defenders) defender.moveToId = null;
  const battle = battleState();
  const outcome = resolveBattle(
    battle,
    attackers,
    defenders,
    new Set(),
    1,
    getMultiDirectionModifier(directionCount),
  );
  assert(outcome);
  return outcome;
}

function resolveToCompletion(directionCount: number) {
  const attackers = Array.from({ length: 6 }, (_, index) => unit(`attacker-${index}`, SOURCES[index % directionCount]));
  const defenders = Array.from({ length: 4 }, (_, index) => unit(`defender-${index}`, TARGET, "land", B));
  for (const defender of defenders) defender.moveToId = null;
  const removed = new Set<UnitState["id"]>();
  let defenderManpowerLoss = 0;
  let winner = "none";
  let durationTicks = 0;
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    for (durationTicks = 1; durationTicks <= 100; durationTicks += 1) {
      const outcome = resolveBattle(
        battleState(), attackers, defenders, removed, durationTicks,
        getMultiDirectionModifier(directionCount),
      );
      assert(outcome);
      defenderManpowerLoss += outcome.defenderManpowerLoss;
      if (outcome.attackerWon) {
        winner = "attacker";
        break;
      }
      if (!attackers.some((attacker) => !removed.has(attacker.id))) {
        winner = "defender";
        break;
      }
    }
  } finally {
    console.info = originalInfo;
  }
  return { durationTicks, winner, defenderManpowerLoss };
}

function directionWorld(): WorldState {
  const regions = [
    region(TARGET, SOURCES),
    ...SOURCES.map((source) => region(source, [TARGET])),
    region(id("far"), []),
  ];
  return { mesoRegions: regions, cache: createWorldCache() } as unknown as WorldState;
}

function approachWorld(): WorldState {
  const x1 = id("x1"), x2 = id("x2"), x3 = id("x3"), x4 = id("x4");
  const regions = [
    region(TARGET, [SOURCES[0], SOURCES[1], SOURCES[3]]),
    region(SOURCES[0], [TARGET, SOURCES[1], x1]),
    region(SOURCES[1], [TARGET, SOURCES[0]]),
    region(SOURCES[3], [TARGET, x4]),
    region(x1, [SOURCES[0], x2]), region(x2, [x1, x3]),
    region(x3, [x2, x4]), region(x4, [x3, SOURCES[3]]),
  ];
  return {
    mesoRegions: regions,
    macroRegions: [
      { id: "macro-a" as never, nationId: A, mesoRegionIds: regions.filter((item) => item.id !== TARGET).map((item) => item.id), isCore: true },
      { id: "macro-b" as never, nationId: B, mesoRegionIds: [TARGET], isCore: true },
    ],
    nations: [{ id: A }, { id: B }],
    occupation: createOccupationState(),
    territoryVersion: 0,
    cache: createWorldCache(),
    units: [],
  } as unknown as WorldState;
}

function targetSelection(
  coverage: OperationTargetSelection["targetCoverageState"],
  defense: number,
): OperationTargetSelection {
  return {
    primaryTargetRegionId: TARGET,
    supportingTargetRegionIds: [],
    stagingRegionId: SOURCES[0],
    nearbyEnemyStrength: defense,
    targetCoverageState: coverage,
    targetLocalDefenderStrength: defense,
    tacticalScore: 1,
    tacticalReasons: [],
  };
}

function region(regionId: MesoRegionId, neighbors: MesoRegionId[]): MesoRegion {
  return {
    id: regionId,
    type: "land",
    centerId: `${regionId}-micro` as MesoRegion["centerId"],
    center: { x: 0, y: 0 },
    microRegionIds: [],
    neighbors: neighbors.map((neighborId) => ({ id: neighborId, hasRiver: false })),
    building: null,
    resource: null,
  };
}

function unit(
  name: string,
  regionId: MesoRegionId,
  domain: UnitState["domain"] = "land",
  nationId: NationId = A,
): UnitState {
  return {
    id: name as UnitState["id"], nationId, regionId,
    type: domain === "land" ? "Infantry" : "CombatShip", domain,
    cargoUnits: [], amphibiousEmbarkRequested: false, amphibiousLandRequested: false,
    equipment: [], moveTicksPerRegion: 1, combatPower: 1, org: 1, manpower: 1_000,
    moveTargetId: TARGET, moveFromId: regionId, moveToId: TARGET, moveProgressMs: 0,
  };
}

function battleState(): BattleState {
  return {
    id: "battle-test" as BattleState["id"], mesoId: TARGET,
    attackerNationId: A, defenderNationId: B, startedAtFastTick: 0, lastActiveFastTick: 0,
    attackDirectionCount: 1, attackSourceRegionIds: [SOURCES[0]],
    attackStrengthBySourceRegion: new Map(), multiDirectionModifier: 1,
    attackerOrganizationLoss: 0, defenderOrganizationLoss: 0,
    attackerManpowerLoss: 0, defenderManpowerLoss: 0,
  };
}

function id(value: string): MesoRegionId {
  return value as MesoRegionId;
}
