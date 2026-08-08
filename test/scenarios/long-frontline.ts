import type { ScenarioSetup } from "./types";
import { ensureLandUnitCount, startAdjacentWars } from "./scenario-utils";

/** A focused observation scenario: few wars and enough land forces to make
 * spacing along each resulting long sector visually and statistically clear. */
export const setupLongFrontline: ScenarioSetup = (world, options) => {
  const added = startAdjacentWars(world, 1);
  if (added === 0) throw new Error("long-frontline requires an adjacent nation pair");
  for (const nation of world.nations) {
    nation.nextWarDeclarationTick = Number.POSITIVE_INFINITY;
  }
  ensureLandUnitCount(world, options.quick ? 180 : 450);
};
