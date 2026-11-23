import assert from "node:assert/strict";
import test from "node:test";
import type { RegionalNegotiation } from "../../src/sim/regional-negotiations";
import { recordSimulationEvent } from "../../src/sim/simulation-settings";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";
import { observeWorldHistory } from "../diagnostics/world-history-observer";

test("recorded negotiation details are snapshots, not live references", () => {
  const world = createFixedSocietyWorld();
  const district = fixedSocietyDistrict(3, 1);
  const owner = world.nations[0]!;
  const sponsor = world.nations[2]!;
  const talks: RegionalNegotiation = {
    dimension: "culture", group: 1, requested: "protected", grievance: 0.2, exclusion: 0.2,
    constituency: 0.3, owner: owner.id, status: "demand", reviewAt: 310, distrust: 0,
    foreignRefusals: { [sponsor.id]: 999 }, reason: "Sustained unequal treatment.",
  };
  world.regionalNegotiations = new Map([[district, talks]]);
  const history = observeWorldHistory(world);
  recordSimulationEvent(world, {
    category: "politics", nationIds: [owner.id],
    message: `${owner.id}, district ${district}: Tide Guilds demanded institutional protections.`,
  });
  const entry = history.timeline.at(-1);
  assert.equal(entry?.kind, "regional-demand");
  const recorded = (entry!.detail as { negotiation: RegionalNegotiation }).negotiation;
  assert.equal(recorded.status, "demand");
  assert.equal(recorded.foreignRefusals?.[sponsor.id], 999);
  // Later mutations of the live case must not rewrite the recorded event.
  talks.status = "agreed";
  talks.foreignRefusals![sponsor.id] = 1234;
  assert.equal(recorded.status, "demand");
  assert.equal(recorded.foreignRefusals?.[sponsor.id], 999);
  history.restoreLog();
});
