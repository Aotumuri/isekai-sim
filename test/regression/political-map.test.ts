import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { createFaction, joinFaction } from "../../src/sim/factions";
import { declareWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
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
  for (const mode of ["factions", "debug", "political"] as const) {
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
