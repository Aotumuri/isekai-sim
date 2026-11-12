import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { getOwnerByMesoId } from "../../src/sim/world-cache";

test("a national portfolio attributes occupied homeland to the actual opponent", () => {
  const world = createScenarioWorld("active-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  world.settings!.warCampaignEnabled = true;
  world.occupation.mesoById.clear();
  const nation = world.nations.find((n) => world.wars.filter((w) =>
    w.nationAId === n.id || w.nationBId === n.id).length > 1)!;
  assert.ok(nation);
  const wars = world.wars.filter((w) => w.nationAId === nation.id || w.nationBId === nation.id);
  const occupier = wars[0].nationAId === nation.id ? wars[0].nationBId : wars[0].nationAId;
  const region = world.mesoRegions.find((r) => getOwnerByMesoId(world).get(r.id) === nation.id)!;
  world.occupation.mesoById.set(region.id, occupier); world.occupation.version++;
  updateWarCampaigns(world);
  const alternatives = world.warCampaigns!.byNationId.get(nation.id)!.alternatives!;
  const defenses = alternatives.filter((a) => a.mode === "defend");
  assert.ok(defenses.find((a) => a.opponentId === occupier)!.defensiveExposure! > 0);
  assert.ok(defenses.filter((a) => a.opponentId !== occupier).every((a) => a.defensiveExposure === 0));
});
