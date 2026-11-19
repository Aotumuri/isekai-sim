import assert from "node:assert/strict";
import test from "node:test";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { recordDirectBattleDamage } from "../../src/sim/war-campaign/battle-costs";
import { observeCampaignCost } from "../../src/sim/war-campaign/forecast";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { declareWar } from "../../src/sim/war-state";
import { createTestScenario } from "../helpers/test-scenario";

test("campaign decay and newly recorded battle losses use the continuing war's opening basis", () => {
  const world = createTestScenario("matched-war");
  world.settings!.warCampaignEnabled = true;
  const [first] = world.wars;
  const nation = world.nations.find((item) => item.id === first.aggressorId)!;
  const opponent = world.nations.find((item) => item.id !== first.aggressorId && item.id !== first.defenderId)!;
  const plan = () => world.warCampaigns!.byNationId.get(nation.id)!;
  const step = () => {
    world.time.fastTick += 10;
    updateWarCampaigns(world);
    return plan();
  };

  const firstBasis = step().objectives[0].openingManpower!;
  const losses = world.warCampaigns!.battleCosts ??= new Map();
  recordDirectBattleDamage(losses, nation.id, 600);
  step();
  world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), nation.id, nation.capitalMesoId, "Infantry"));
  const second = declareWar(world.wars, nation.id, opponent.id, world.time.fastTick)!;
  assert(second);
  const concurrent = step();
  const secondBasis = Math.max(...concurrent.objectives.map((goal) => goal.openingManpower!));
  assert(secondBasis > firstBasis);
  const carry = concurrent.observation!.lossFractionPerDay;
  assert(carry > 0);
  assert(Math.abs(carry - (600 / secondBasis / 10) * 0.2 * 0.8) < 1e-12,
    "expanding the basis only rescales and decays the carried rate");

  world.wars = world.wars.filter((war) => war !== second);
  const after = step();
  assert.equal(after.objectives.length, 1);
  assert(after.constraints.casualtyFraction > concurrent.constraints.casualtyFraction);
  assert(Math.abs(after.observation!.lossFractionPerDay - carry * (secondBasis / firstBasis) * 0.8) < 1e-12,
    "continuing-war forecast must not differentiate fractions on different scales");

  recordDirectBattleDamage(losses, nation.id, 125);
  const next = step();
  assert(Math.abs(next.observation!.lossFractionPerDay - (after.observation!.lossFractionPerDay * 0.8 + (125 / firstBasis / 10) * 0.2)) < 1e-12,
    "new real losses still enter both observations on the same scale");
});

test("the first cost observation starts at zero and legacy objectives supply the old basis", () => {
  const world = createTestScenario("matched-war");
  world.settings!.warCampaignEnabled = true;
  const nationId = world.wars[0].aggressorId;
  updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.get(nationId)!;
  assert.equal(campaign.observation!.lossFractionPerDay, 0);

  const openingStrength = 400;
  const legacyCampaign = {
    ...campaign,
    objectives: [{ ...campaign.objectives[0], openingManpower: undefined, openingStrength }],
    observation: { tick: world.time.fastTick, casualtyFraction: 0.25, lossFractionPerDay: 0.0125 },
  };
  world.time.fastTick += 10;
  // The basis doubles while 20 newly unavailable manpower enter the ledger.
  assert(Math.abs(observeCampaignCost(world, 120 / 800, 800, legacyCampaign).lossFractionPerDay - 0.0055) < 1e-12);
  assert.equal(observeCampaignCost(world, 0.5, 800, { ...legacyCampaign, observation: undefined }).lossFractionPerDay, 0);
});
