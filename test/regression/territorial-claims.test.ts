import assert from "node:assert/strict";
import test from "node:test";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { getForeignClaims, getTerritorialClaim, getTerritorialClaims, updateTerritorialClaims } from "../../src/sim/territorial-claims";
import { getRelation } from "../../src/sim/diplomacy";
import { updateCivilWar } from "../../src/sim/civil-war";
import { updateDomesticUnrest } from "../../src/sim/domestic-unrest";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { declareWar } from "../../src/sim/war-state";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

test("territorial tenure increases attachment and survives loss; resource claims have independent value", () => {
  const world = createFixedSocietyWorld(), [a, b] = world.nations;
  const macro = world.macroRegions.find((item) => item.nationId === a.id)!;
  const id = macro.mesoRegionIds[0], before = getTerritorialClaim(world, a.id, id);
  world.time.slowTick += 500; updateTerritorialClaims(world);
  assert(getTerritorialClaim(world, a.id, id) > before);
  const memory = getTerritorialClaims(world).history.get(id)!.get(a.id)!;
  assert.equal(memory.heldTicks, 500);
  macro.nationId = b.id; world.territoryVersion++;
  updateTerritorialClaims(world);
  assert(getForeignClaims(world, a.id, b.id).some((claim) => claim.regionId === id && claim.heldTicks === 500));
  const region = world.mesoRegions.find((item) => item.id === id)!;
  region.resource = null; const without = getTerritorialClaim(world, a.id, id);
  region.resource = "fuel"; assert(getTerritorialClaim(world, a.id, id) > without);
});

test("unilateral seizures and new occupations damage relations once, while agreed cessions do not", () => {
  const world = createFixedSocietyWorld(), [a, b] = world.nations;
  const macro = world.macroRegions.find((item) => item.nationId === a.id)!;
  const relation = getRelation(world, a.id, b.id), initial = relation.opinion;
  world.occupation.mesoById.set(macro.mesoRegionIds[0], b.id);
  updateTerritorialClaims(world); assert(relation.opinion < initial);
  const after = relation.opinion; updateTerritorialClaims(world); assert.equal(relation.opinion, after);
  macro.nationId = b.id; world.territoryVersion++;
  updateTerritorialClaims(world, new Set([a.id, b.id])); assert.equal(relation.opinion, after);
  const other = world.macroRegions.find((item) => item.nationId === a.id)!;
  assert(other); other.nationId = b.id; world.territoryVersion++;
  updateTerritorialClaims(world); assert(relation.opinion < after);
});


test("revolutionary governments inherit past claims and tenure in their new territory", () => {
  const world = createFixedSocietyWorld();
  const parent = world.nations.find((nation) => {
    const provinces = world.macroRegions.filter((macro) => macro.nationId === nation.id);
    return provinces.length > 1 && world.mesoRegions.some((region) =>
      region.building === "city" && provinces.some((macro) => macro.mesoRegionIds.includes(region.id)));
  });
  assert.ok(parent);
  const foreign = world.nations.find((nation) => nation.id !== parent.id && nation.macroRegionIds.length > 0)!;
  const lostRegion = world.macroRegions.filter((macro) => macro.nationId === parent.id)
    .flatMap((macro) => macro.mesoRegionIds)
    .find((id) => world.mesoRegions.find((region) => region.id === id)?.building === null);
  assert.ok(lostRegion);

  updateTerritorialClaims(world);
  world.time.slowTick = 500;
  assert.ok(transferTerritories(world, [{ from: parent.id, to: foreign.id, regionIds: [lostRegion] }], "agreement"));
  declareWar(world.wars, parent.id, foreign.id, 0);
  parent.warCooperation = 0;
  updateDomesticUnrest(world);
  world.time.slowTick = 800;
  const originalCount = world.nations.length;
  withMutedSimulationLogs(() => updateCivilWar(world));

  assert.equal(world.nations.length, originalCount + 1);
  const rebel = world.nations.at(-1)!;
  for (const government of [parent, rebel]) {
    assert.ok(getForeignClaims(world, government.id, foreign.id)
      .some((claim) => claim.regionId === lostRegion && claim.heldTicks === 500));
  }
  const history = getTerritorialClaims(world).history;
  const previousClaim = history.get(lostRegion)!.get(parent.id)!;
  const inheritedClaim = history.get(lostRegion)!.get(rebel.id)!;
  assert.deepEqual(inheritedClaim, previousClaim);
  assert.notEqual(inheritedClaim, previousClaim);
  assert.equal(history.get(rebel.capitalMesoId)?.get(rebel.id)?.heldTicks, 800);

  updateTerritorialClaims(world);
  world.time.slowTick += 10;
  updateTerritorialClaims(world);
  assert.equal(history.get(rebel.capitalMesoId)?.get(rebel.id)?.heldTicks, 810);
  assert.equal(history.get(rebel.capitalMesoId)?.get(parent.id)?.heldTicks, 800);
});
