import test from "node:test";
import assert from "node:assert/strict";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { getFrontAllocation, updateNationFrontAllocations } from "../../src/sim/nation-front-allocations";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { getStalemateAssessment, updateStalematePressure } from "../../src/sim/stalemate-pressure";

function twoFronts() {
  const world = createFixedSocietyWorld();
  const [a, b, c, d] = world.nations;
  // Join the upper/lower countries into two governments, with two disconnected
  // land borders. Preserve the actual district graph on each side of the cut.
  for (const macro of world.macroRegions) {
    if (macro.nationId === c.id) macro.nationId = a.id;
    if (macro.nationId === d.id) macro.nationId = b.id;
  }
  for (const nation of world.nations) nation.macroRegionIds = world.macroRegions
    .filter((macro) => macro.nationId === nation.id).map((macro) => macro.id);
  const regions = new Map(world.mesoRegions.map((region) => [region.id, region]));
  for (const region of world.mesoRegions) region.neighbors = region.neighbors.filter((next) =>
    (region.center.y < 160) === (regions.get(next.id)!.center.y < 160));
  world.units = [];
  for (const [nation, region] of [[a.id, fixedSocietyDistrict(4, 2)], [b.id, fixedSocietyDistrict(5, 2)],
    [a.id, fixedSocietyDistrict(4, 5)], [b.id, fixedSocietyDistrict(5, 5)]] as const) {
    for (let i = 0; i < 3; i++) world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), nation, region, "Infantry"));
  }
  world.mapVersion++; world.territoryVersion++;
  world.settings!.warCampaignEnabled = true;
  declareWar(world.wars, a.id, b.id, 0);
  updateLandFronts(world); updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.get(a.id)!;
  campaign.mode = "limited-offensive"; campaign.militaryMode = "limited-offensive";
  campaign.primaryOpponentId = b.id;
  updateNationFrontPlans(world); updateStalematePressure(world);
  const focus = getStalemateAssessment(world, a.id, b.id)!;
  assert.ok(focus.schwerpunktSectorId);
  const secondary = world.frontPlans.plansByNationId.get(a.id)!.find((plan) => plan.frontId !== focus.schwerpunktSectorId)!;
  assert.ok(secondary);
  secondary.desiredStrength = 10000;
  secondary.reasonFlags = [];
  return { world, nation: a.id, secondary };
}

test("changing only emergency demand protection invalidates cached concentration allocation", () => {
  const { world, nation, secondary } = twoFronts();
  updateNationFrontAllocations(world);
  const ordinary = getFrontAllocation(world, secondary.frontId, nation)!;
  assert.ok(ordinary.desiredStrength < secondary.desiredStrength);
  for (const flag of ["capital-threatened", "major-force-supply-risk", "supply-corridor", "bridgehead-campaign"] as const) {
    const version = world.frontAllocations.version;
    secondary.reasonFlags = [flag];
    updateNationFrontAllocations(world);
    assert.ok(world.frontAllocations.version > version);
    assert.equal(getFrontAllocation(world, secondary.frontId, nation)!.desiredStrength, 10000);
    secondary.reasonFlags = [];
    updateNationFrontAllocations(world);
    assert.equal(getFrontAllocation(world, secondary.frontId, nation)!.desiredStrength, ordinary.desiredStrength);
  }
});
