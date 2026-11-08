import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getRelation, getDiplomacyState } from "../../src/sim/diplomacy";
import { grantMilitaryAccess, requestMilitaryAccess, hasMilitaryAccess, updateMilitaryAccess, getMilitaryRoutingOwners, getMilitaryAccessState, findMilitaryAccessRoute } from "../../src/sim/military-access";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { updateSupplyAssessment, isNationRegionSupplied } from "../../src/sim/supply-assessment";
import { startDiplomaticWar } from "../../src/sim/diplomatic-crises";

export function accessScene() {
  const world = createSocietyWorld(), owners = getOwnerByMesoId(world);
  const source = world.mesoRegions.find((region) => region.type !== "sea" && region.neighbors.some((neighbor) => owners.get(neighbor.id) && owners.get(neighbor.id) !== owners.get(region.id)))!;
  const guest = owners.get(source.id)!, next = source.neighbors.find((neighbor) => owners.get(neighbor.id) && owners.get(neighbor.id) !== guest)!.id;
  const host = owners.get(next)!, relation = getRelation(world, host, guest);
  relation.opinion = 70; relation.trust = 80;
  return { world, guest, host, source: source.id, next, relation };
}

test("access is directional and trust is required even for close partners", () => {
  const { world, guest, host, relation } = accessScene();
  relation.trust = 59; assert.equal(grantMilitaryAccess(world, host, guest), false);
  relation.trust = 60; assert(grantMilitaryAccess(world, host, guest));
  assert(hasMilitaryAccess(world, guest, host)); assert.equal(hasMilitaryAccess(world, host, guest), false);
  assert.equal(grantMilitaryAccess(world, host, guest), false);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(host), 24);
  assert(requestMilitaryAccess(world, host, guest));
  assert.equal(getDiplomacyState(world).influenceByNationId.get(host), 18);
});

test("real land movement crosses trusted territory and local supply is shared without changing ownership", () => {
  const { world, guest, host, source, next } = accessScene();
  assert.equal(findMilitaryAccessRoute(world, guest, source, next), null);
  assert(grantMilitaryAccess(world, host, guest)); assert.deepEqual(findMilitaryAccessRoute(world, guest, source, next), [source, next]);
  assert.equal(getOwnerByMesoId(world).get(next), host); assert.equal(getMilitaryRoutingOwners(world, guest).get(next), guest);
  const unit = createUnitForType(createUnitId(world.unitIdCounter++), guest, source, "Infantry"); world.units = [unit];
  getMilitaryAccessState(world).orders.set(unit.id, { nationId: guest, destinationId: next });
  for (let tick = 0; tick < 50; tick++) { world.time.fastTick++; repositionUnits(world, 100); }
  assert.equal(unit.regionId, next); assert.equal(getOwnerByMesoId(world).get(next), host);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, guest, next), isNationRegionSupplied(world, host, next));
});

test("loss of trust ends access, invalidates routes and repatriates neutral visitors after a grace period", () => {
  const { world, guest, host, source, next, relation } = accessScene(); assert(grantMilitaryAccess(world, host, guest));
  const unit = createUnitForType(createUnitId(world.unitIdCounter++), guest, next, "Infantry"); world.units = [unit];
  getMilitaryRoutingOwners(world, guest); relation.trust = 49; updateMilitaryAccess(world);
  assert.equal(hasMilitaryAccess(world, guest, host), false); assert.equal(findMilitaryAccessRoute(world, guest, source, next), null);
  assert.equal(unit.regionId, next); world.time.slowTick += 15; updateMilitaryAccess(world);
  assert.equal(unit.regionId, world.nations.find((nation) => nation.id === guest)!.capitalMesoId);
});

test("access cannot be used to pre-position an instant invasion against the host", () => {
  const { world, guest, host, next } = accessScene(); assert(grantMilitaryAccess(world, host, guest));
  const unit = createUnitForType(createUnitId(world.unitIdCounter++), guest, next, "Infantry"); world.units = [unit];
  assert(startDiplomaticWar(world, guest, host));
  assert.equal(unit.regionId, world.nations.find((nation) => nation.id === guest)!.capitalMesoId);
  assert.equal(hasMilitaryAccess(world, guest, host), false);
});
