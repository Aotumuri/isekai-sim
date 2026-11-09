import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { createFaction, joinFaction } from "../../src/sim/factions";
import { declareWar } from "../../src/sim/war-state";
import { getAdjacentNationPairs, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createDefaultWorldConfig } from "../../src/data/world-config";
import { createWorld } from "../../src/sim/create-world";
import { getMapView, setMapMode, selectMapNation } from "../../src/render/map-view-state";
import { classifyPoliticalBoundary, getDiplomaticStatus, getNationLabelAnchors, getPoliticalFill } from "../../src/render/political-map-data";
import { createSocietyWorld } from "../helpers/society-world";

test("player boundaries preserve coastlines and national borders without ocean or district grids", () => {
  assert.equal(classifyPoliticalBoundary(), "none");
  assert.equal(classifyPoliticalBoundary("a", "p1", "a", "p1"), "none");
  assert.equal(classifyPoliticalBoundary("a", "p1", "a", "p2"), "province");
  assert.equal(classifyPoliticalBoundary("a", "p1", "b", "p2"), "national");
  assert.equal(classifyPoliticalBoundary("a", "p1", undefined, undefined), "national");
});

test("diplomatic colors prioritize war and distinguish friendly, neutral and hostile nations", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  assert(a && b);
  const relation = getRelation(world, a.id, b.id);
  relation.opinion = 0; assert.equal(getDiplomaticStatus(world, a.id, b.id), "neutral");
  relation.opinion = 40; assert.equal(getDiplomaticStatus(world, a.id, b.id), "friendly");
  relation.opinion = -30; assert.equal(getDiplomaticStatus(world, a.id, b.id), "hostile");
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 100 });
  assert.equal(getDiplomaticStatus(world, a.id, b.id), "friendly");
  declareWar(world.wars, a.id, b.id, 0);
  assert.equal(getDiplomaticStatus(world, a.id, b.id), "war");
  assert.equal(getDiplomaticStatus(world, a.id, a.id), "selected");
});

test("every map mode allows national selection and selection immediately changes the diplomatic reference", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  assert(a && b);
  assert.equal(setMapMode(world, "diplomacy"), false);
  selectMapNation(world, a.id); assert(setMapMode(world, "diplomacy"));
  selectMapNation(world, b.id);
  assert.equal(getMapView(world).selectedNationId, b.id);
  assert.equal(getMapView(world).diplomaticFocusId, b.id);
  assert.equal(getMapView(world).targetNationId, a.id);
  setMapMode(world, "diplomacy"); assert.equal(getMapView(world).diplomaticFocusId, b.id);
  for (const mode of ["factions", "debug", "political", "claims"] as const) {
    setMapMode(world, mode); selectMapNation(world, a.id);
    assert.equal(getMapView(world).selectedNationId, a.id);
    assert.equal(getMapView(world).diplomaticFocusId, a.id);
  }
  setMapMode(world, "political"); selectMapNation(world, b.id);
  assert.equal(getMapView(world).selectedNationId, b.id);
});

test("faction mode colors allies identically and keeps non-aligned states distinct", () => {
  const world = createSocietyWorld(), [a, b, c] = world.nations;
  assert(a && b && c);
  a.ideologyId = b.ideologyId = "capitalism";
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  const relation = getRelation(world, a.id, b.id); relation.opinion = 80; relation.trust = 80;
  const faction = createFaction(world, a.id, { allowedIdeologyIds: ["capitalism"], defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: false })!;
  assert(faction && joinFaction(world, b.id, faction.id));
  setMapMode(world, "factions");
  assert.equal(getPoliticalFill(world, a.id), getPoliticalFill(world, b.id));
  assert.notEqual(getPoliticalFill(world, a.id), getPoliticalFill(world, c.id));
});

test("country labels are anchored on owned land, including disconnected holdings", () => {
  const world = createSocietyWorld(), anchors = getNationLabelAnchors(world), owners = getOwnerByMesoId(world);
  assert(anchors.length >= world.nations.length);
  for (const anchor of anchors) {
    assert.equal(owners.get(anchor.regionId), anchor.nationId);
    assert.notEqual(world.mesoRegions.find((region) => region.id === anchor.regionId)?.type, "sea");
  }
});

test("occupation overlays distinguish the owner from the controller and disappear on liberation or annexation", async () => {
  const { getPlayerOccupations, getOccupationSummary } = await import("../../src/render/political-map-data");
  const world = createSocietyWorld(), [owner, occupier] = world.nations;
  assert(owner && occupier);
  const macro = world.macroRegions.find((item) => item.nationId === owner.id)!;
  const occupiedRegions = macro.mesoRegionIds.slice(0, 2);
  assert(occupiedRegions.length > 0);
  for (const id of occupiedRegions) world.occupation.mesoById.set(id, occupier.id);
  world.occupation.version += 1;
  assert.equal(getPlayerOccupations(world).length, occupiedRegions.length);
  assert.deepEqual(getOccupationSummary(world), [{ ownerId: owner.id, occupierId: occupier.id, regions: occupiedRegions.length }]);
  for (const id of occupiedRegions) world.occupation.mesoById.delete(id);
  world.occupation.version += 1;
  assert.equal(getPlayerOccupations(world).length, 0);
  // Stale occupation records after a legal transfer must not paint false occupation.
  for (const id of occupiedRegions) world.occupation.mesoById.set(id, occupier.id);
  macro.nationId = occupier.id; world.territoryVersion += 1;
  assert.equal(getPlayerOccupations(world).length, 0);
  assert.equal(getMapView(world).occupations, true);
});

test("puppets use a darker shade of their overlord's political color", () => {
  const world = createSocietyWorld(), [overlord, subject] = world.nations;
  assert(overlord && subject);
  const original = getPoliticalFill(world, subject.id);
  const parent = getPoliticalFill(world, overlord.id);
  subject.subjectGovernment = { overlordId: overlord.id, establishedAtFastTick: 0 };
  const puppet = getPoliticalFill(world, subject.id);
  assert.notEqual(puppet, parent);
  for (const shift of [0, 8, 16]) {
    assert.equal((puppet >> shift) & 0xff, Math.round(((parent >> shift) & 0xff) * 0.68));
  }
  delete subject.subjectGovernment;
  assert.equal(getPoliticalFill(world, subject.id), original);
});

test("political colors distinguish neighboring countries and reserve dark shades for puppets", () => {
  const world = createWorld({ ...createDefaultWorldConfig(), seed: 17, microRegionCount: 32_000,
    nationTargetMacroRegionsPerNation: 2 });
  const colors = world.nations.map(({ id }) => getPoliticalFill(world, id));
  assert.equal(new Set(colors).size, colors.length);
  const channels = (color: number) => [color >> 16, (color >> 8) & 0xff, color & 0xff];
  const brightest = (color: number) => Math.max(...channels(color));
  assert.ok(Math.min(...colors.map(brightest)) > Math.max(...colors.map(brightest)) * 0.68);

  const neighbors = getAdjacentNationPairs(world);
  assert.ok(neighbors.length > 0);
  for (const [a, b] of neighbors) {
    const left = channels(getPoliticalFill(world, a));
    const right = channels(getPoliticalFill(world, b));
    assert.ok(Math.hypot(...left.map((channel, index) => channel - right[index]!)) > 75, `${a} / ${b}`);
  }
});
