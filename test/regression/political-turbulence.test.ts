import assert from "node:assert/strict";
import test from "node:test";
import { updateBorderIncidents } from "../../src/sim/border-incidents";
import { getDefensePact, getRelation, isDiplomaticallyProtected } from "../../src/sim/diplomacy";
import { updateDefensePacts } from "../../src/sim/defense-pacts";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getFactionState } from "../../src/sim/factions";
import { getNationCharacter } from "../../src/sim/nation-character";
import { getNationalPolitics, updateNationalPolitics } from "../../src/sim/politics";
import { updateNationalistMovements } from "../../src/sim/nationalist-movements";
import { getForeignClaims } from "../../src/sim/territorial-claims";
import { isTradeEmbargoed, updateFactionSanctions } from "../../src/sim/trade-embargo";
import { declareWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createNationId } from "../../src/worldgen/nation";
import { createSocietyWorld } from "../helpers/society-world";

function scene() {
  const world = createSocietyWorld();
  world.settings!.politicalTurbulenceEnabled = true;
  return world;
}

test("states facing a shared threat can form a temporary, targeted defense pact", () => {
  const world = scene(), [a, b] = world.nations;
  const threat = { ...a, id: createNationId(2) };
  world.nations.push(threat);
  const relation = getRelation(world, a.id, b.id);
  relation.opinion = 5;
  world.commonThreatCoalitions.coalitions.push({ id: "test", memberNationIds: [a.id, b.id], targetNationId: threat.id,
    formedAtSlowTick: 30, age: 60, formationReason: "shared-land-threat", pendingDissolutionReason: null, unstableTicks: 0 });
  world.time.slowTick = 90;
  updateDefensePacts(world);
  assert.equal(getDefensePact(world, a.id, b.id)?.against, threat.id);
  assert.ok(isDiplomaticallyProtected(world, a.id, b.id));
  assert.ok(!isDiplomaticallyProtected(world, a.id, threat.id));
  world.time.slowTick = 330;
  assert.equal(getDefensePact(world, a.id, b.id), undefined);
});

test("a bloc sanctions an aggressor together and trade can resume after sanctions expire", () => {
  const world = scene(), [a, b] = world.nations;
  const aggressor = { ...a, id: createNationId(2) };
  world.nations.push(aggressor);
  getFactionState(world).factions.push({
    id: "test-bloc", name: "Test bloc", founderId: a.id, leaderId: a.id, memberIds: [a.id, b.id],
    createdAtSlowTick: 0, charter: { allowedIdeologyIds: [], defensiveObligation: "none",
      offensiveObligation: "none", considerPersonality: false },
  });
  declareWar(world.wars, aggressor.id, a.id, 0);
  world.time.slowTick = 20;
  updateFactionSanctions(world);
  assert.ok(isTradeEmbargoed(world, a.id, aggressor.id));
  assert.ok(isTradeEmbargoed(world, b.id, aggressor.id));
  assert.ok(!isTradeEmbargoed(world, a.id, b.id));
  world.wars = [];
  world.time.slowTick = 140;
  updateFactionSanctions(world);
  assert.ok(!isTradeEmbargoed(world, b.id, aggressor.id));
});

test("reunification movements claim matching districts beyond the border and then expire", () => {
  const world = scene();
  const [a, b] = world.nations;
  a.populationPolicy = { type: "homeland", group: 0 };
  const districts = world.macroRegions.filter(({ nationId }) => nationId === b.id).flatMap(({ mesoRegionIds }) => mesoRegionIds);
  for (const id of districts) {
    const population = world.regionalPopulations!.get(id)!;
    population.ancestry = [population.size, 0, 0, 0, 0, 0];
  }
  const before = getForeignClaims(world, a.id, b.id).length;
  world.time.slowTick = 120;
  updateNationalistMovements(world);
  assert.equal(a.nationalistMovement?.targetId, b.id);
  assert.equal(getForeignClaims(world, a.id, b.id).length, districts.length);
  assert.ok(before < districts.length);
  assert.ok(getRelation(world, a.id, b.id).grievance >= 30);
  world.time.slowTick = 360;
  assert.equal(getForeignClaims(world, a.id, b.id).length, before);
});

test("opposing border deployments create a cooldown-limited diplomatic incident", () => {
  const world = scene(), [a, b] = world.nations;
  const owners = getOwnerByMesoId(world);
  const border = world.mesoRegions.find((region) => owners.get(region.id) === a.id &&
    region.neighbors.some(({ id }) => owners.get(id) === b.id))!;
  const opposite = border.neighbors.find(({ id }) => owners.get(id) === b.id)!;
  for (const [nation, region] of [[a, border], [b, opposite]] as const) {
    const unit = world.units.find((item) => item.nationId === nation.id && item.domain === "land")!;
    unit.regionId = region.id;
    unit.org = 1;
  }
  getNationCharacter(world, a.id).aggression = 0.9;
  const relation = getRelation(world, a.id, b.id);
  relation.opinion = 0;
  world.time.slowTick = 90;
  updateBorderIncidents(world);
  assert.ok(relation.grievance > 0);
  const tension = relation.tension;
  world.time.slowTick += 15;
  updateBorderIncidents(world);
  assert.equal(relation.tension, tension);
});

test("a banned opposition grows underground but cannot take seats until the ban expires", () => {
  const world = scene(), nation = world.nations[0]!;
  nation.ideologyId = "capitalism";
  const politics = getNationalPolitics(world, nation);
  politics.system = "democracy";
  getNationCharacter(world, nation.id).aggression = 0.8;
  politics.support = new Map([["capitalism", 35], ["communism", 55], ["cohesionism", 10]]);
  world.time.slowTick = politics.nextMandateAt = 120;
  updateNationalPolitics(world);
  assert.equal(politics.suppression?.ideologyId, "communism");
  assert.ok(politics.support.get("communism")! > 55);
  assert.equal(politics.seats.get("communism"), undefined);
  assert.equal([...politics.seats.values()].reduce((a, b) => a + b), 100);
  assert.ok(getDomesticUnrest(world, nation.id).pressure > 0);
  world.time.slowTick = politics.nextMandateAt = 360;
  updateNationalPolitics(world);
  assert.equal(politics.suppression, undefined);
  assert.equal(politics.governingIdeologyId, "communism");
});
