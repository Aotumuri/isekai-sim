import test from "node:test";
import assert from "node:assert/strict";
import { recordDirectBattleDamage, recordFormationRemoval, unavailableManpower, type CampaignBattleCosts } from "../../src/sim/war-campaign/battle-costs";
import type { UnitState } from "../../src/sim/unit";
import type { NationId } from "../../src/worldgen/nation";
import { createScenarioWorld } from "../scenarios";
import { observeCampaignBattleDamage, observeCampaignFormationRemoval } from "../../src/sim/war-campaign/battle-cost-observation";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";

const nation = "nation" as NationId;
function unit(overrides: Partial<UnitState> = {}): UnitState {
  return { id: "unit" as UnitState["id"], nationId: nation, type: "Infantry", domain: "land",
    regionId: "a" as UnitState["regionId"], manpower: 1100, org: 0, combatPower: 1,
    equipment: [], cargoUnits: [], moveTicksPerRegion: 16, moveProgressMs: 0,
    moveTargetId: null, moveFromId: null, moveToId: null,
    amphibiousEmbarkRequested: false, amphibiousLandRequested: false, ...overrides };
}
test("organization collapse accounts for remaining unavailable manpower without double-counting direct damage", () => {
  const costs: CampaignBattleCosts = new Map();
  recordDirectBattleDamage(costs, nation, 100);
  const formation = unit();
  const before = structuredClone(formation);
  recordFormationRemoval(costs, formation);
  assert.equal(unavailableManpower(costs.get(nation)), 1200);
  assert.equal(costs.get(nation)!.formationsRemoved, 1);
  assert.deepEqual(formation, before);
});
test("a lost transport includes crew and cargo once, and does not create or consume stock", () => {
  const costs: CampaignBattleCosts = new Map();
  const cargo = unit({ equipment: [{ equipmentKey: "rifle" as never, fill: 0.5 }] });
  const transport = unit({ id: "transport" as UnitState["id"], type: "TransportShip", domain: "naval",
    manpower: 300, cargoUnits: [cargo, cargo] });
  recordFormationRemoval(costs, transport);
  assert.equal(unavailableManpower(costs.get(nation)), 1400);
  assert.equal(costs.get(nation)!.formationsRemoved, 2);
  assert.equal(cargo.manpower, 1100);
});

test("cost observation is opt-in, preserves resources and clears after all national wars end", () => {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, width: 640, height: 360, quick: true });
  const nationId = world.wars[0].aggressorId;
  const own = world.units.find((u) => u.nationId === nationId)!;
  const nation = world.nations.find((n) => n.id === nationId)!;
  const resources = structuredClone(nation.resources);
  observeCampaignBattleDamage(world, nationId, 100);
  assert.equal(world.warCampaigns, undefined);
  world.settings!.warCampaignEnabled = true;
  observeCampaignBattleDamage(world, nationId, 100);
  observeCampaignFormationRemoval(world, own);
  assert.ok(unavailableManpower(world.warCampaigns!.battleCosts!.get(nationId)) >= own.manpower + 100);
  assert.deepEqual(nation.resources, resources);
  updateWarCampaigns(world);
  assert.ok(world.warCampaigns!.battleCosts!.has(nationId));
  world.wars = [];
  updateWarCampaigns(world);
  assert.equal(world.warCampaigns!.battleCosts!.size, 0);
});
