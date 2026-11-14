import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { startAdjacentWars } from "./scenario-utils";
import type { ScenarioSetup } from "./types";

/** Equal force composition and stocks isolate geography from starting strength.
 * Imbalance and scarcity are scenario inputs, never changes to combat rules. */
function controlledWar(unequal: boolean, scarce: boolean): ScenarioSetup {
  return (world) => {
    world.wars = [];
    if (startAdjacentWars(world, 1) !== 1) throw new Error("Controlled war requires an adjacent pair");
    const war = world.wars[0];
    const ids = [war.aggressorId, war.defenderId];
    world.units = world.units.filter((unit) => !ids.includes(unit.nationId));
    for (const nation of world.nations) nation.nextWarDeclarationTick = Infinity;
    for (const id of ids) {
      const nation = world.nations.find((item) => item.id === id)!;
      const count = unequal && id === war.defenderId ? 10 : 20;
      for (let index = 0; index < count; index += 1) {
        const type = index % 10 === 0 ? "Tank" : "Infantry";
        world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), id, nation.capitalMesoId, type));
      }
      nation.resources.manpower = scarce ? 0 : 5000;
      nation.resources.weapons = scarce ? 0 : 80;
      nation.resources.fuel = scarce ? 0 : 100;
      nation.resources.steel = scarce ? 0 : 100;
    }
  };
}

export const setupMatchedWar = controlledWar(false, false);
export const setupUnequalWar = controlledWar(true, false);
export const setupEconomicConstraint = controlledWar(false, true);
