import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { createOpeningGovernmentObserver } from "../helpers/war-government-outcome-observer";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { installSubjectGovernment, releaseSubjectGovernment } from "../../src/sim/subject-governments";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";

function opening() {
  const world = createScenarioWorld("matched-war", { seed: 822748319788, width: 640, height: 360, quick: true });
  world.settings!.diplomacyEnabled = true;
  world.wars.forEach((war) => { war.isTest = false; });
  const war = world.wars[0];
  return { world, war };
}

test("keeping every district under a new master differs from preserving independence, and the result freezes at peace", () => {
  const { world, war } = opening(), government = createOpeningGovernmentObserver(world, [war]);
  const territory = createWarOutcomeObserver();
  const random = world.simRng.fork().nextFloat();
  government.observe(world); territory.observe(world);
  assert.equal(world.simRng.fork().nextFloat(), random);
  installSubjectGovernment(world, war.aggressorId, war.defenderId);
  world.wars = []; world.time.fastTick = 100;
  government.observe(world); territory.observe(world);
  const result = government.result().find((item) => !item.aggressor)!;
  assert.equal(territory.result().wars.find((item) => !item.aggressor)!.objectiveHeld, true);
  assert.equal(result.status, "subject");
  assert.equal(result.capitalLegallyOwned, true);
  assert.equal(result.governmentPreserved, false);
  assert.equal(government.result().find((item) => item.aggressor)!.opponentSubjectToUs, true);
  releaseSubjectGovernment(world, war.aggressorId, war.defenderId);
  world.time.fastTick = 110; government.observe(world);
  assert.deepEqual(government.result().find((item) => !item.aggressor), result);
  assert.equal(government.currentStates(world).find((item) => item.nationId === war.defenderId)!.status, "independent");
});

test("the common observer preserves an opening dependent relationship or independence, but rejects a new master", () => {
  const { world, war } = opening();
  const parent = world.nations.find((nation) => nation.id !== war.aggressorId && nation.id !== war.defenderId)!;
  installSubjectGovernment(world, parent.id, war.defenderId);
  const observer = createOpeningGovernmentObserver(world, [war]);
  observer.observe(world);
  const defender = () => observer.result().find((item) => !item.aggressor)!;
  assert.equal(defender().openingOverlordId, parent.id);
  assert.equal(defender().governmentPreserved, true);
  installSubjectGovernment(world, war.aggressorId, war.defenderId);
  observer.observe(world);
  assert.equal(defender().governmentPreserved, false);
  releaseSubjectGovernment(world, war.aggressorId, war.defenderId);
  assert.ok(proposePeaceTerms(world, war.aggressorId, war.defenderId, whitePeaceTerms()));
  assert.ok(acceptPeaceOffer(world, war.defenderId, war.aggressorId));
  observer.observe(world);
  assert.equal(defender().status, "independent");
  assert.equal(defender().governmentPreserved, true);
  assert.equal(defender().endedAtTick, 0);
});
