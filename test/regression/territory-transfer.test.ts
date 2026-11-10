import assert from "node:assert/strict";
import test from "node:test";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { splitProvince, transferTerritories } from "../../src/sim/territory-transfer";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getTerritorialClaims } from "../../src/sim/territorial-claims";

test("partial cessions partition provinces and keep ownership, capitals, armies and caches coherent", () => {
  const world = createFixedSocietyWorld(), [a, b] = world.nations;
  const id = a.capitalMesoId, owners = new Map(getOwnerByMesoId(world));
  const unit = world.units.find((item) => item.nationId === a.id && item.domain === "land")!;
  unit.regionId = id; unit.moveToId = id;
  const stocks = { ...a.resources };
  assert(transferTerritories(world, [{ from: a.id, to: b.id, regionIds: [id] }]));
  assert.equal(getOwnerByMesoId(world).get(id), b.id);
  assert.equal(getOwnerByMesoId(world).get(a.capitalMesoId), a.id);
  assert.notEqual(a.capitalMesoId, id); assert.equal(unit.regionId, a.capitalMesoId); assert.equal(unit.moveToId, null);
  assert.deepEqual(a.resources, stocks);
  for (const [other, owner] of owners) if (other !== id) assert.equal(getOwnerByMesoId(world).get(other), owner);
  for (const nation of world.nations) assert.deepEqual(new Set(nation.macroRegionIds), new Set(world.macroRegions.filter((macro) => macro.nationId === nation.id).map((macro) => macro.id)));
  const all = world.macroRegions.flatMap((macro) => macro.mesoRegionIds);
  assert.equal(all.length, new Set(all).size);
  assert(getTerritorialClaims(world).history.get(id)?.has(a.id));
});

test("territorial exchanges are atomic and reject duplicate, foreign, sea and last-territory cessions", () => {
  const world = createFixedSocietyWorld(), [a, b] = world.nations;
  const aIds = [...getOwnerByMesoId(world)].filter(([, owner]) => owner === a.id).map(([id]) => id);
  const bId = b.capitalMesoId, before = new Map(getOwnerByMesoId(world));
  assert.equal(transferTerritories(world, [{ from: a.id, to: b.id, regionIds: [aIds[0]] }, { from: b.id, to: a.id, regionIds: [aIds[0]] }]), false);
  assert.deepEqual(getOwnerByMesoId(world), before);
  assert.equal(transferTerritories(world, [{ from: a.id, to: b.id, regionIds: aIds }]), false);
  assert(transferTerritories(world, [{ from: a.id, to: b.id, regionIds: [aIds[0]] }, { from: b.id, to: a.id, regionIds: [bId] }]));
  assert.equal(getOwnerByMesoId(world).get(aIds[0]), b.id); assert.equal(getOwnerByMesoId(world).get(bId), a.id);
});

test("administrative division creates a province without changing national territory", () => {
  const world = createFixedSocietyWorld(), macro = world.macroRegions.find((item) => item.mesoRegionIds.length > 1)!;
  const owners = new Map(getOwnerByMesoId(world)), count = world.macroRegions.length;
  assert(splitProvince(world, macro.nationId, macro.id, [macro.mesoRegionIds[0]]));
  assert.equal(world.macroRegions.length, count + 1); assert.deepEqual(getOwnerByMesoId(world), owners);
  assert.equal(splitProvince(world, macro.nationId, macro.id, [...macro.mesoRegionIds]), false);
});

test("capital swaps preserve one correct capital marker per nation without resetting bystander losses", () => {
  const world = createFixedSocietyWorld(), [a, b, c] = world.nations;
  c.initialCityCount = 99;
  assert(transferTerritories(world, [{ from: a.id, to: b.id, regionIds: [a.capitalMesoId] }, { from: b.id, to: a.id, regionIds: [b.capitalMesoId] }]));
  const owners = getOwnerByMesoId(world);
  for (const nation of [a, b]) {
    const capitals = world.mesoRegions.filter((region) => owners.get(region.id) === nation.id && region.building === "capital");
    assert.equal(capitals.length, 1); assert.equal(capitals[0].id, nation.capitalMesoId);
  }
  assert.equal(c.initialCityCount, 99);
});
