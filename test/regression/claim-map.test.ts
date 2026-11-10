import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getMapClaims, getClaimColor, CLAIM_COLORS } from "../../src/render/claim-map-data";
import { getMapView, selectMapNation, setMapMode, toggleClaimsMap } from "../../src/render/map-view-state";
import { getPoliticalFill } from "../../src/render/political-map-data";
import { getTerritorialClaims, updateTerritorialClaims } from "../../src/sim/territorial-claims";
import { getRelation } from "../../src/sim/diplomacy";
import { formatRegionTooltip } from "../../src/render/region/tooltip";

test("claims mode requires selection, rebases on every selection, and returns to the previous view", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  assert.equal(toggleClaimsMap(world), false);
  selectMapNation(world, a.id); setMapMode(world, "factions");
  assert(toggleClaimsMap(world)); assert.equal(getMapView(world).mode, "claims");
  assert.equal(getPoliticalFill(world, a.id), CLAIM_COLORS.home);
  selectMapNation(world, b.id);
  assert.equal(getPoliticalFill(world, b.id), CLAIM_COLORS.home);
  assert.equal(getPoliticalFill(world, a.id), CLAIM_COLORS.other);
  toggleClaimsMap(world); assert.equal(getMapView(world).mode, "factions");
  toggleClaimsMap(world); selectMapNation(world, null);
  assert.equal(getMapView(world).mode, "political");
});

test("claim overlays retain historical and resource interest, exclude home land, and clear returned land", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  const macro = world.macroRegions.find((item) => item.nationId === a.id)!;
  const id = macro.mesoRegionIds[0]!;
  world.time.slowTick += 600; updateTerritorialClaims(world);
  macro.nationId = b.id; world.territoryVersion++; updateTerritorialClaims(world);
  const entry = getMapClaims(world, a.id).find((claim) => claim.regionId === id)!;
  assert(entry); assert.equal(entry.ownerId, b.id); assert.equal(entry.heldTicks, 600);
  assert(entry.strength >= 68); assert.equal(entry.demanded, false);
  const region = world.mesoRegions.find((item) => item.id === id)!;
  region.resource = null;
  const before = getMapClaims(world, a.id).find((claim) => claim.regionId === id)!.strength;
  region.resource = "fuel";
  assert(getMapClaims(world, a.id).find((claim) => claim.regionId === id)!.strength > before);
  macro.nationId = a.id; world.territoryVersion++;
  assert(!getMapClaims(world, a.id).some((claim) => claim.regionId === id));
});

test("formal demands remain visible below the interest threshold and disappear when withdrawn", () => {
  const world = createSocietyWorld(), [a, b] = world.nations;
  const macro = world.macroRegions.find((item) => item.nationId === b.id)!;
  const region = world.mesoRegions.find((item) => item.id === macro.mesoRegionIds[0])!;
  region.resource = null; getTerritorialClaims(world).history.get(region.id)?.delete(a.id);
  const relation = getRelation(world, a.id, b.id);
  relation.crisis = { aggressorId: a.id, demand: "territory", regionIds: [region.id, region.id], openedAtSlowTick: 0, deadlineSlowTick: 100 };
  const claims = getMapClaims(world, a.id).filter((claim) => claim.regionId === region.id);
  assert.equal(claims.length, 1); assert.equal(claims[0]!.demanded, true);
  assert(claims[0]!.strength < 20);
  selectMapNation(world, a.id); setMapMode(world, "claims");
  const micro = world.microRegions.find((item) => item.mesoRegionId === region.id)!;
  const tooltip = formatRegionTooltip(micro, region, macro, b, [], world);
  assert.match(tooltip, /請求の強さ：/); assert.match(tooltip, /発出中の領土最後通牒/);
  relation.crisis = null;
  assert(!getMapClaims(world, a.id).some((claim) => claim.regionId === region.id));
  assert(!getMapClaims(world, b.id).some((claim) => claim.regionId === region.id));
});

test("claim color scale has bounded distinguishable endpoints", () => {
  assert.equal(getClaimColor(20), CLAIM_COLORS.weak); assert.equal(getClaimColor(100), CLAIM_COLORS.strong);
  assert.equal(getClaimColor(-1), CLAIM_COLORS.weak); assert.equal(getClaimColor(110), CLAIM_COLORS.strong);
  assert.notEqual(getClaimColor(60), CLAIM_COLORS.weak); assert.notEqual(getClaimColor(60), CLAIM_COLORS.strong);
});
