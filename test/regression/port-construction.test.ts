import assert from "node:assert/strict";
import test from "node:test";
import { constructPort, PORT_CONSTRUCTION_COST } from "../../src/sim/port-construction";
import { isNationRegionSupplied, updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { getMesoById, getOwnerByMesoId, getPortTargetsByNation } from "../../src/sim/world-cache";
import { createSocietyWorld } from "../helpers/society-world";

test("building a port spends resources once and updates the naval port index", () => {
  const world = createSocietyWorld();
  updateSupplyAssessment(world);
  const regions = getMesoById(world), owners = getOwnerByMesoId(world);
  const site = world.mesoRegions.find((region) => {
    const owner = owners.get(region.id);
    return owner && region.building === null && isNationRegionSupplied(world, owner, region.id) &&
      region.neighbors.some(({ id }) => regions.get(id)?.type === "sea");
  });
  assert.ok(site);
  const nation = world.nations.find((item) => item.id === owners.get(site.id))!;
  const other = world.nations.find((item) => item.id !== nation.id)!;
  assert.equal(constructPort(world, nation.id, site.id), false);
  nation.resources.steel = PORT_CONSTRUCTION_COST.steel;
  nation.resources.fuel = PORT_CONSTRUCTION_COST.fuel;
  assert.equal(constructPort(world, other.id, site.id), false);
  world.occupation.mesoById.set(site.id, other.id);
  world.occupation.version++;
  assert.equal(constructPort(world, nation.id, site.id), false);
  world.occupation.mesoById.delete(site.id);
  world.occupation.version++;
  assert.ok(!getPortTargetsByNation(world).get(nation.id)?.includes(site.id));
  assert.ok(constructPort(world, nation.id, site.id));
  assert.equal(site.building, "port");
  assert.ok(getPortTargetsByNation(world).get(nation.id)?.includes(site.id));
  assert.equal(nation.resources.steel, 0);
  assert.equal(nation.resources.fuel, 0);
  assert.equal(constructPort(world, nation.id, site.id), false);
});
