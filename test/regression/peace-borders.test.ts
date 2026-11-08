import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { createMesoRegionId } from "../../src/worldgen/meso-region";
import { createMacroRegionId } from "../../src/worldgen/macro-region";
import { getPeaceBorderIssue, selectPeaceDistricts } from "../../src/sim/peace-borders";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getPeaceTermsIssue, proposePeaceTerms, acceptPeaceOffer, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { getOwnerByMesoId } from "../../src/sim/world-cache";

// Explicit graphs keep coastlines, narrow corridors and existing enclaves deterministic.
function scene(ownership: string, edges: number[][]) {
  const world = createSocietyWorld(), [a, b, c] = world.nations;
  const id = createMesoRegionId, template = world.mesoRegions[0];
  world.mesoRegions = [...ownership].map((_, index) => ({ ...template, id: id(index), type: "land" as const,
    resource: index === 2 ? "steel" as const : null, building: null,
    neighbors: edges.flatMap(([x, y]) => x === index ? [{ id: id(y), hasRiver: false }] : y === index ? [{ id: id(x), hasRiver: false }] : []) }));
  world.macroRegions = world.nations.map((nation, index) => ({ id: createMacroRegionId(index), nationId: nation.id, isCore: true,
    mesoRegionIds: [...ownership].flatMap((owner, i) => owner === "abc"[index] ? [id(i)] : []) }));
  world.nations.forEach((nation, i) => { nation.macroRegionIds = [createMacroRegionId(i)]; nation.capitalMesoId = world.macroRegions[i].mesoRegionIds[0]; nation.resources.weapons = 100; });
  world.mapVersion++; world.territoryVersion++;
  world.occupation.mesoById.clear(); world.wars.length = 0;
  declareWar(world.wars, a.id, b.id, 0);
  const leg = (...indices: number[]) => [{ from: b.id, to: a.id, regionIds: indices.map(id) }];
  return { world, a, b, c, id, leg };
}

test("peace rejects an isolated resource district even when occupied by the recipient", () => {
  const { world, a, b, id, leg } = scene("abbbb", [[0, 1], [1, 2], [2, 3], [3, 4], [1, 3]]);
  world.occupation.mesoById.set(id(2), a.id);
  assert.match(getPeaceBorderIssue(world, leg(2))!, /enclaves/);
  assert(getPeaceTermsIssue(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [id(2)] }));
  assert(!proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [id(2)] }));
});
test("border districts and connected corridors can be ceded together", () => {
  const { world, leg } = scene("abbbb", [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.equal(getPeaceBorderIssue(world, leg(1, 2)), null);
});
test("peace cannot sever the donor's narrow land corridor", () => {
  const { world, leg } = scene("abbb", [[0, 2], [1, 2], [2, 3]]);
  assert.match(getPeaceBorderIssue(world, leg(2))!, /split/);
});
test("pre-existing disconnected holdings do not prevent a sensible border settlement", () => {
  const { world, leg } = scene("abbbab", [[0, 1], [1, 2], [2, 3], [4, 5]]);
  assert.equal(getPeaceBorderIssue(world, leg(1)), null);
});
test("a complete overseas island is allowed, but one coastal district of it is not", () => {
  const { world, leg } = scene("abbbb", [[0, 1], [1, 2], [3, 4]]);
  assert.match(getPeaceBorderIssue(world, leg(3))!, /enclaves/);
  assert.equal(getPeaceBorderIssue(world, leg(3, 4)), null);
});
test("reciprocal exchanges use the final border including the incoming connection", () => {
  const { world, a, b, id, leg } = scene("aabb", [[0, 1], [1, 2], [2, 3], [0, 2], [1, 3]]);
  assert.equal(getPeaceBorderIssue(world, [...leg(2), { from: a.id, to: b.id, regionIds: [id(1)] }]), null);
});
test("losing a whole old component cannot hide splitting another component", () => {
  const { world, leg } = scene("abbbb", [[0, 2], [0, 4], [1, 2], [2, 3]]);
  assert.match(getPeaceBorderIssue(world, leg(2, 4))!, /split/);
});
test("acceptance rechecks changed borders without transferring land, money or ending war", () => {
  const { world, a, b, c, id } = scene("aabbb", [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert(proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [id(2)], demandedWeapons: 20 }));
  world.macroRegions[0].mesoRegionIds = [id(0)]; world.macroRegions[2].mesoRegionIds.push(id(1)); world.territoryVersion++;
  assert(!acceptPeaceOffer(world, b.id, a.id));
  assert.equal(getOwnerByMesoId(world).get(id(2)), b.id); assert.equal(getOwnerByMesoId(world).get(id(1)), c.id);
  assert.equal(a.resources.weapons, 100); assert.equal(b.resources.weapons, 100); assert(findWar(world.wars, a.id, b.id));
});
test("AI revisits valuable interior districts after choosing a connecting border and respects the cap", () => {
  const { world, a, b, id } = scene("abbbb", [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(selectPeaceDistricts(world, b.id, a.id, [id(2), id(1), id(3)], 2), [id(1), id(2)]);
  assert.deepEqual(selectPeaceDistricts(world, b.id, a.id, [id(2)], 3), []);
});
test("AI transfers whole small islands together and skips corridor cuts", () => {
  const island = scene("abbbb", [[0, 1], [1, 2], [3, 4]]);
  assert.deepEqual(selectPeaceDistricts(island.world, island.b.id, island.a.id, [island.id(3), island.id(4)], 2), [island.id(3), island.id(4)]);
  assert.deepEqual(selectPeaceDistricts(island.world, island.b.id, island.a.id, [island.id(3), island.id(4)], 1), []);
  const corridor = scene("abbb", [[0, 2], [1, 2], [2, 3]]);
  assert.deepEqual(selectPeaceDistricts(corridor.world, corridor.b.id, corridor.a.id, [corridor.id(2)], 2), []);
});

test("individually valid cessions cannot bypass validation of the combined exchange", () => {
  const { world, a, b, id, leg } = scene("aabb", [[0, 1], [1, 2], [2, 3]]);
  const offer = { from: a.id, to: b.id, regionIds: [id(1)] };
  assert.equal(getPeaceBorderIssue(world, leg(2)), null);
  assert.equal(getPeaceBorderIssue(world, [offer]), null);
  assert.match(getPeaceBorderIssue(world, [...leg(2), offer])!, /enclaves/);
});
