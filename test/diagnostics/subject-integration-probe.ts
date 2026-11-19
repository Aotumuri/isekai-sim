import assert from "node:assert/strict";
import { getRelation } from "../../src/sim/diplomacy";
import { getNationCharacter } from "../../src/sim/nation-character";
import { updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { DAYS_PER_SLOW_TICK } from "../../src/sim/time";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSocietyWorld } from "../helpers/society-world";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

for (const initiallyAligned of [true, false]) {
  const world = withMutedSimulationLogs(createSocietyWorld);
  world.settings!.politicalTurbulenceEnabled = true;
  const [overlord, subject] = world.nations;
  assert(overlord && subject && world.regionalPopulations);
  getNationCharacter(world, overlord.id).aggression = 0.8;
  getRelation(world, overlord.id, subject.id).trust = 65;
  subject.subjectGovernment = { overlordId: overlord.id, establishedAtFastTick: 0, autonomy: 0 };
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = world.regionalPopulations.get(id);
    if (!population) continue;
    const group = owner === overlord.id || initiallyAligned ? 0 : 1;
    for (const dimension of ["culture", "faith"] as const) {
      population[dimension] = population[dimension].map((_, index) => index === group ? population.size : 0);
    }
  }
  overlord.resources.copper = 7;
  subject.resources.copper = 19;
  const initialCopper = [overlord.resources.copper, subject.resources.copper];
  let adoptedDay: number | undefined;
  for (let tick = 10; tick <= 800 && subject.macroRegionIds.length; tick += 10) {
    world.time.slowTick = tick;
    world.time.fastTick = tick * DAYS_PER_SLOW_TICK;
    updateTerritorialGovernance(world);
    if (subject.governance?.policy === "assimilation") adoptedDay ??= world.time.fastTick;
  }
  console.log(JSON.stringify({
    initiallyAligned, adoptedDay, integratedDay: subject.macroRegionIds.length ? null : world.time.fastTick,
    governance: subject.governance, initialCopper, finalCopper: [overlord.resources.copper, subject.resources.copper],
  }));
}
