import type { ScenarioSetup } from "./types";
import { ensureLandUnitCount, startAdjacentWars } from "./scenario-utils";

export const setupCollapseAdvance: ScenarioSetup = (world) => {
  ensureLandUnitCount(world, 80);
  if (startAdjacentWars(world, 1) !== 1) throw new Error("collapse-advance requires an adjacent war");
  const war = world.wars[0];
  if (!war) throw new Error("collapse-advance failed to create war");
  // Territory and cities remain, but the defender has no coherent land line.
  let retainedAttackers = 0;
  world.units = world.units.filter((unit) => {
    if (unit.domain !== "land") return true;
    if (unit.nationId === war.defenderId) { unit.manpower = 1; unit.org = 0.1; return true; }
    if (unit.nationId !== war.aggressorId) return true;
    retainedAttackers += 1;
    return retainedAttackers <= 12;
  });
  for (const unit of world.units) if (unit.domain === "land" && unit.nationId === war.aggressorId) unit.manpower *= 2;
  for (const nation of world.nations) {
    nation.nextWarDeclarationTick = Number.POSITIVE_INFINITY;
    nation.nextUnitProductionTick = Number.POSITIVE_INFINITY;
  }
};
