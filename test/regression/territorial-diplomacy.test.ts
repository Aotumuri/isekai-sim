import { selectPeaceDistricts } from "../../src/sim/peace-borders";
import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getTerritorialClaims } from "../../src/sim/territorial-claims";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { betrayTerritorialSettlement, getNationalMilitaryStrength, openDiplomaticCrisis, respondToCrisis, startDiplomaticWar, updateDiplomaticCrises } from "../../src/sim/diplomatic-crises";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";

function scene() {
  const world = createSocietyWorld(); updateSupplyAssessment(world); updateStrategicThreatObservation(world);
  const candidates = world.strategicThreatObservation.exposures.filter((item) => item.landAdjacent)
    .flatMap(({ observerNationId: a, threatNationId: b }) => {
      const parcels = [...getOwnerByMesoId(world)].filter(([id, owner]) =>
        owner === b && id !== world.nations.find((nation) => nation.id === b)!.capitalMesoId).map(([id]) => id);
      return selectPeaceDistricts(world, b, a, parcels, 1).map((id) => ({ a, b, id }));
    });
  assert.ok(candidates.length);
  const { a, b, id } = candidates[0];
  getTerritorialClaims(world).history.get(id)!.set(a, { heldTicks: 500, attachment: 60 });
  const ratio = getNationalMilitaryStrength(world, b) / Math.max(1, getNationalMilitaryStrength(world, a));
  for (const unit of world.units.filter((item) => item.nationId === a)) unit.manpower *= ratio * 1.2;
  getDiplomacyState(world).influenceByNationId.set(a, 100);
  world.nations.find((nation) => nation.id === b)!.character = { doctrine: "pragmatist", aggression: 0.6, cooperation: 0.5, innovation: 0.5, thrift: 0.5 };
  return { world, a, b, id, relation: getRelation(world, a, b) };
}

test("accepted territorial ultimatums recover only named regions without weapon tribute or war", () => {
  const { world, a, b, id, relation } = scene(), before = new Map(getOwnerByMesoId(world));
  const stock = world.nations.find((nation) => nation.id === b)!.resources.weapons;
  assert(openDiplomaticCrisis(world, a, b, [id])); assert.equal(relation.crisis?.demand, "territory");
  assert(respondToCrisis(world, b, a, "concede"));
  assert.equal(getOwnerByMesoId(world).get(id), a);
  for (const [other, owner] of before) if (other !== id) assert.equal(getOwnerByMesoId(world).get(other), owner);
  assert.equal(world.nations.find((nation) => nation.id === b)!.resources.weapons, stock);
  assert.equal(world.wars.length, 0); assert.equal(startDiplomaticWar(world, a, b), false);
  assert(betrayTerritorialSettlement(world, a, b)); assert.equal(world.wars.length, 1);
  assert.equal(betrayTerritorialSettlement(world, a, b), false);
});

test("invalid territorial demands spend no influence and stale demands cannot seize another owner's land", () => {
  const { world, a, b, id, relation } = scene();
  assert.equal(openDiplomaticCrisis(world, a, b, [id, id]), false);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(a), 100);
  assert(openDiplomaticCrisis(world, a, b, [id]));
  const macro = world.macroRegions.find((item) => item.mesoRegionIds.includes(id))!;
  const c = world.nations.find((nation) => nation.id !== a && nation.id !== b)!.id;
  macro.nationId = c; world.territoryVersion++;
  assert.equal(respondToCrisis(world, b, a, "concede"), false);
  updateDiplomaticCrises(world); assert.equal(relation.crisis, null);
  assert.equal(getOwnerByMesoId(world).get(id), c); assert.equal(world.wars.length, 0);
});

test("rejecting a territorial ultimatum escalates without preemptively changing ownership", () => {
  const { world, a, b, id } = scene(); assert(openDiplomaticCrisis(world, a, b, [id]));
  assert(respondToCrisis(world, b, a, "reject")); updateDiplomaticCrises(world);
  assert.equal(getOwnerByMesoId(world).get(id), b); assert.equal(world.wars.length, 1);
});

test("an old territorial agreement cannot authorize betrayal of an unrelated later truce", () => {
  const { world, a, b, id, relation } = scene();
  assert(openDiplomaticCrisis(world, a, b, [id])); assert(respondToCrisis(world, b, a, "concede"));
  world.time.slowTick += 10;
  relation.treaties = [{ type: "truce", expiresAtSlowTick: world.time.slowTick + 300 }];
  const influence = getDiplomacyState(world).influenceByNationId.get(a);
  assert.equal(betrayTerritorialSettlement(world, a, b), false);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(a), influence);
  assert.equal(world.wars.length, 0);
});
