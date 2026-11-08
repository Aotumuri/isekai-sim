import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getForeignClaims, getTerritorialClaim, getTerritorialClaims, updateTerritorialClaims } from "../../src/sim/territorial-claims";
import { getRelation } from "../../src/sim/diplomacy";

test("territorial tenure increases attachment and survives loss; resource claims have independent value", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
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
  const world = createSocietyWorld(), [a, b] = world.nations;
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
