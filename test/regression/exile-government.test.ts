import assert from "node:assert/strict";
import test from "node:test";
import { createExileWorld } from "../helpers/exile-world";
import { updateSurrender } from "../../src/sim/surrender";
import { updateExileGovernments } from "../../src/sim/exile-government";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getRelation, updateDiplomaticRelations } from "../../src/sim/diplomacy";
import { updateFactions, getNationFaction } from "../../src/sim/factions";
import { declareWar, findWar } from "../../src/sim/war-state";
import { isNationActive, isNationPresent } from "../../src/sim/nation-active";
import { getMapClaims } from "../../src/render/claim-map-data";
import { allFieldUnits } from "../../src/sim/mobilization";
import { updateProduction } from "../../src/sim/production";
import { restoreExiledTerritories } from "../../src/sim/territory-transfer";

test("capitulation creates a recognized allied exile, preserves homeland claims and transfers faction leadership", () => {
  const { world, a, host, faction, homeland, escapees } = createExileWorld();
  const designs = escapees.map((unit) => unit.design);
  updateSurrender(world);
  const record = world.exileGovernments?.byNationId.get(a.id)!; assert(record);
  assert.equal(record.status, "exiled"); assert.equal(record.hostId, host.id);
  assert.equal(isNationActive(a), false); assert.equal(isNationPresent(world, a), true);
  assert.equal(record.reserveUnits.length, escapees.length); assert.deepEqual(record.reserveUnits.map((unit) => unit.design), designs);
  assert.equal(faction.leaderId, host.id);
  assert.equal(findWar(world.wars, a.id, host.id), null);
  assert(homeland.every((id) => getMapClaims(world, a.id).some((claim) => claim.regionId === id)));
  assert.equal(new Set(allFieldUnits(world).map((unit) => unit.id)).size, allFieldUnits(world).length);
  world.time.slowTick = 30; updateDiplomaticRelations(world); updateFactions(world);
  assert.equal(getNationFaction(world, a.id), faction); assert(world.diplomacy?.relations.has([a.id, host.id].sort().join(":")));
});

test("unsafe or untrusted hosts cannot prevent normal surrender; trapped troops do not teleport out", () => {
  const { world, a, host, homeland } = createExileWorld();
  getRelation(world, a.id, host.id).trust = 59;
  updateSurrender(world); assert(!world.exileGovernments?.byNationId.has(a.id)); assert(!isNationActive(a));
  const second = createExileWorld();
  for (const unit of second.escapees) unit.regionId = second.homeland[0]!;
  updateSurrender(second.world);
  assert.equal(second.world.exileGovernments?.byNationId.get(second.a.id)?.evacuatedUnits, 0);
  assert(homeland.length > 0);
});

test("escaped units arrive once under host command and an occupied homeland produces no new national army", () => {
  const { world, a, host, escapees } = createExileWorld();
  updateSurrender(world); const record = world.exileGovernments!.byNationId.get(a.id)!;
  world.time.slowTick = record.arrivesAtSlowTick - 1; updateExileGovernments(world);
  assert(!world.units.some((unit) => escapees.includes(unit)));
  world.time.slowTick++; updateExileGovernments(world);
  assert.equal(record.reserveUnits.length, 0);
  for (const unit of escapees) { assert.equal(unit.nationId, host.id); assert.equal(unit.exileOriginId, a.id); assert.equal(unit.regionId, host.capitalMesoId); }
  const count = world.units.length; updateExileGovernments(world); assert.equal(world.units.length, count);
  updateProduction(world); assert(!world.units.some((unit) => unit.nationId === a.id));
});

test("actual allied liberation restores only controlled homeland, returns surviving forces, and resumes the war", () => {
  const { world, a, host, enemy, homeland, escapees } = createExileWorld();
  updateSurrender(world); const record = world.exileGovernments!.byNationId.get(a.id)!;
  world.time.slowTick = record.arrivesAtSlowTick; updateExileGovernments(world);
  const target = homeland[0]!;
  assert(!restoreExiledTerritories(world, a.id, host.id, [target]));
  const foreign = world.mesoRegions.find((region) => getOwnerByMesoId(world).get(region.id) === host.id)!;
  assert(!restoreExiledTerritories(world, a.id, host.id, [foreign.id]));
  world.occupation.mesoById.set(target, host.id); world.occupation.version++;
  updateExileGovernments(world);
  assert.equal(record.status, "restored"); assert.equal(getOwnerByMesoId(world).get(target), a.id);
  assert.equal(a.capitalMesoId, target); assert(findWar(world.wars, a.id, enemy.id));
  assert.equal(record.reserveUnits.length, escapees.length);
  updateSurrender(world); assert(isNationActive(a), "returning forces have a bounded reorganization grace period");
  world.time.slowTick = record.arrivesAtSlowTick; updateExileGovernments(world);
  for (const unit of escapees) { assert.equal(unit.nationId, a.id); assert.equal(unit.exileOriginId, undefined); assert.equal(unit.regionId, target); }
  const next = homeland.find((id) => id !== target)!;
  world.occupation.mesoById.set(next, host.id); world.occupation.version++;
  updateExileGovernments(world); assert.equal(getOwnerByMesoId(world).get(next), a.id); assert.equal(record.restoredDistricts, 2);
  assert.equal(new Set(allFieldUnits(world).map((unit) => unit.id)).size, allFieldUnits(world).length);
});

test("a failed host leads to relocation when possible and dissolution when every trusted ally is gone", () => {
  const { world, a, host, enemy, other } = createExileWorld();
  const relation = getRelation(world, a.id, other.id); relation.trust = relation.opinion = 60;
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 1000 }); declareWar(world.wars, enemy.id, other.id, 0);
  updateSurrender(world); const record = world.exileGovernments!.byNationId.get(a.id)!;
  assert.equal(record.hostId, host.id);
  getRelation(world, a.id, host.id).trust = 0; updateExileGovernments(world);
  assert.equal(record.status, "exiled"); assert.equal(record.hostId, other.id);
  getRelation(world, a.id, other.id).trust = 0; updateExileGovernments(world);
  assert.equal(record.status, "dissolved"); assert.equal(isNationPresent(world, a), false); assert.equal(record.reserveUnits.length, 0);
});

test("legacy mode and allies simultaneously capitulating do not create immortal exile governments", () => {
  const first = createExileWorld(); first.world.settings!.diplomacyEnabled = false;
  updateSurrender(first.world); assert(!first.world.exileGovernments);
  const { world, host, enemy, a } = createExileWorld();
  for (const [id, owner] of getOwnerByMesoId(world)) if (owner === host.id) world.occupation.mesoById.set(id, enemy.id);
  world.occupation.version++; updateSurrender(world);
  assert(!world.exileGovernments?.byNationId.has(a.id)); assert(!world.exileGovernments?.byNationId.has(host.id));
});

test("liberation after a host victory restores the government even though the old enemy's war has ended", () => {
  const { world, a, host, enemy, homeland } = createExileWorld();
  updateSurrender(world); const record = world.exileGovernments!.byNationId.get(a.id)!;
  // The host annexes an enemy province containing the old homeland in the ordinary settlement path.
  const macro = world.macroRegions.find((item) => item.mesoRegionIds.includes(homeland[0]!))!;
  macro.nationId = host.id;
  enemy.macroRegionIds = enemy.macroRegionIds.filter((id) => id !== macro.id); host.macroRegionIds.push(macro.id);
  world.territoryVersion++;
  world.wars = world.wars.filter((war) => ![war.nationAId, war.nationBId].includes(host.id));
  updateExileGovernments(world);
  assert.equal(record.status, "restored"); assert(isNationActive(a));
  assert.equal(getOwnerByMesoId(world).get(homeland[0]!), a.id);
});

test("the restoration grace period expires and a new total defeat still follows normal surrender", () => {
  const { world, a, host, homeland } = createExileWorld();
  updateSurrender(world); const record = world.exileGovernments!.byNationId.get(a.id)!;
  for (const unit of record.reserveUnits) unit.manpower = 0;
  record.reserveUnits = [];
  world.occupation.mesoById.set(homeland[0]!, host.id); world.occupation.version++;
  updateExileGovernments(world); assert.equal(record.status, "restored");
  world.time.slowTick = record.graceUntilSlowTick;
  getRelation(world, a.id, host.id).trust = 0;
  updateSurrender(world); assert(!isNationActive(a));
  assert.equal(record.status, "dissolved");
});

test("exiled governments can maintain diplomacy but cannot receive fictitious new armies through faction calls", async () => {
  const { improveRelations, proposeTreaty } = await import("../../src/sim/diplomacy");
  const { updateFactionWarCalls } = await import("../../src/sim/factions");
  const { world, a, host, other, enemy } = createExileWorld();
  updateSurrender(world);
  const hostile = getRelation(world, a.id, enemy.id); hostile.opinion = hostile.trust = 80;
  assert(!improveRelations(world, a.id, enemy.id)); assert(!proposeTreaty(world, a.id, enemy.id, "alliance"));
  const { getDiplomaticStatus } = await import("../../src/render/political-map-data");
  assert.equal(getDiplomaticStatus(world, a.id, enemy.id), "war");
  assert(improveRelations(world, a.id, host.id));
  assert(proposeTreaty(world, a.id, host.id, "alliance"));
  declareWar(world.wars, other.id, host.id, world.time.fastTick);
  updateFactionWarCalls(world);
  assert.equal(findWar(world.wars, a.id, other.id), null);
  assert(!world.units.some((unit) => unit.nationId === a.id));
});

test("evacuation respects the receiving country's hard army capacity", async () => {
  const { WORLD_BALANCE } = await import("../../src/data/balance");
  const { createUnitId } = await import("../../src/sim/unit");
  const { world, a, host } = createExileWorld();
  const base = world.units.find((unit) => unit.nationId === host.id && unit.domain === "land")!;
  const limit = WORLD_BALANCE.production.maxMobilizedLandUnits;
  while (world.units.filter((unit) => unit.nationId === host.id && unit.domain === "land").length < limit)
    world.units.push({ ...base, id: createUnitId(world.unitIdCounter++), cargoUnits: [] });
  updateSurrender(world);
  assert.equal(world.exileGovernments!.byNationId.get(a.id)!.evacuatedUnits, 0);
  assert.equal(allFieldUnits(world).filter((unit) => unit.nationId === host.id && unit.domain === "land").length, limit);
});

test("liberating an occupier's relocated capital cannot leave that country pointing at the restored government's capital", async () => {
  const { updateCapitals } = await import("../../src/sim/capitals");
  const { world, a, host, enemy, homeland } = createExileWorld();
  updateSurrender(world);
  const target = homeland[0]!;
  enemy.capitalMesoId = target;
  world.mesoRegions.find((region) => region.id === target)!.building = "capital";
  world.occupation.mesoById.set(target, host.id); world.occupation.version++;
  updateExileGovernments(world);
  assert.equal(getOwnerByMesoId(world).get(enemy.capitalMesoId), enemy.id);
  assert.notEqual(enemy.capitalMesoId, a.capitalMesoId);
  updateCapitals(world);
  assert.equal(world.mesoRegions.find((region) => region.id === a.capitalMesoId)!.building, "capital");
});
