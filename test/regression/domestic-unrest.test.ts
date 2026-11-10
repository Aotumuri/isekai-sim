import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getDomesticUnrest, updateDomesticUnrest, canRevolt, recordRevolution, relieveUnrestAfterPeace } from "../../src/sim/domestic-unrest";
import { updateCivilWar } from "../../src/sim/civil-war";
import { getRegionalPopulations, POPULATION_DIMENSIONS, POPULATION_GROUPS } from "../../src/sim/regional-population";
import { declareWar } from "../../src/sim/war-state";
function scene() { const world = createSocietyWorld(), [nation, enemy] = world.nations; declareWar(world.wars, nation.id, enemy.id, 0); nation.warCooperation = 0; updateDomesticUnrest(world); return { world, nation, enemy }; }
test("zero support must persist for at least five minutes instead of causing an immediate revolution", () => {
  const { world, nation } = scene(); const count = world.nations.length;
  updateCivilWar(world); assert.equal(world.nations.length, count);
  world.time.slowTick = 299; updateDomesticUnrest(world); assert(!canRevolt(world, nation.id));
  world.time.slowTick = 300; updateDomesticUnrest(world); assert(canRevolt(world, nation.id));
  const pressure = getDomesticUnrest(world, nation.id).pressure; updateDomesticUnrest(world); assert.equal(getDomesticUnrest(world, nation.id).pressure, pressure);
});
test("recovering support and peace reverse unrest rather than leaving an inevitable revolution queued", () => {
  const { world, nation } = scene(); world.time.slowTick = 250; updateDomesticUnrest(world);
  assert(getDomesticUnrest(world, nation.id).pressure > 60);
  world.wars = []; relieveUnrestAfterPeace(world, nation.id);
  world.time.slowTick = 300; updateDomesticUnrest(world); assert(!canRevolt(world, nation.id));
  world.time.slowTick = 500; updateDomesticUnrest(world); assert.equal(getDomesticUnrest(world, nation.id).pressure, 0);
});
test("parent and rebel governments receive a ten-minute revolution cooldown", () => {
  const { world, nation, enemy } = scene(); recordRevolution(world, nation.id, enemy.id);
  world.time.slowTick = 599; updateDomesticUnrest(world); assert(!canRevolt(world, nation.id));
  assert.equal(getDomesticUnrest(world, nation.id).revolutions, 1);
  world.time.slowTick = 600; updateDomesticUnrest(world); assert(!canRevolt(world, nation.id));
});

test("time spent inside a revolution cooldown cannot count toward a new crisis", () => {
  const { world, nation, enemy } = scene(); recordRevolution(world, nation.id, enemy.id);
  world.time.slowTick = 899; updateDomesticUnrest(world);
  assert.equal(getDomesticUnrest(world, nation.id).lowSupportSeconds, 299); assert(!canRevolt(world, nation.id));
  world.time.slowTick = 900; updateDomesticUnrest(world); assert(canRevolt(world, nation.id));
});

test("sustained moderate discontent is a crisis rather than an eligible revolution", () => {
  const { world, nation } = scene(); nation.warCooperation = 0.3;
  world.time.slowTick = 360; updateDomesticUnrest(world);
  assert.equal(getDomesticUnrest(world, nation.id).phase, "crisis"); assert(!canRevolt(world, nation.id));
});

function identityScene() {
  const world = createSocietyWorld();
  const parent = world.nations.find((nation) => nation.macroRegionIds.length > 1)!;
  const province = world.macroRegions.find((item) =>
    item.nationId === parent.id && !item.mesoRegionIds.includes(parent.capitalMesoId))!;
  const districts = world.mesoRegions.filter((region) => province.mesoRegionIds.includes(region.id));
  const seat = districts.find((region) => region.type === "land" && region.building === null)!;
  const populations = getRegionalPopulations(world);
  for (const population of populations.values()) {
    for (const dimension of POPULATION_DIMENSIONS) population[dimension] = [population.size, 0, 0, 0, 0, 0];
  }
  return { world, parent, province, districts, seat, populations };
}

for (const dimension of POPULATION_DIMENSIONS) {
  test(`a revolution over ${dimension} begins where the affected group is concentrated`, () => {
    const { world, parent, province, districts, seat, populations } = identityScene();
    for (const district of districts) {
      const population = populations.get(district.id)!;
      const share = district.id === seat.id ? 1 : 0.65;
      population[dimension] = [population.size * (1 - share), population.size * share, 0, 0, 0, 0];
    }
    const originalCount = world.nations.length;
    const unrest = getDomesticUnrest(world, parent.id);
    unrest.pressure = 60;
    updateCivilWar(world);
    assert.equal(world.nations.length, originalCount);

    unrest.pressure = 100;
    updateCivilWar(world);
    assert.equal(world.nations.length, originalCount + 1);
    const rebels = world.nations.at(-1)!;
    assert.equal(rebels.capitalMesoId, seat.id);
    assert.deepEqual(rebels.macroRegionIds, [province.id]);
    assert.ok(world.events?.some(({ message }) => message.startsWith("革命") && message.includes(POPULATION_GROUPS[dimension][1]!)));
  });
}

test("full peacetime unrest without a regional identity divide does not trigger separatism", () => {
  const { world, parent } = identityScene();
  const originalCount = world.nations.length;
  getDomesticUnrest(world, parent.id).pressure = 100;
  updateCivilWar(world);
  assert.equal(world.nations.length, originalCount);
});
