import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import type { ScenarioSetup } from "./types";
import { startAdjacentWars } from "./scenario-utils";
import { buildOwnerByMesoId } from "./scenario-utils";

/** Equal, well-manned opponents intended to settle first and then exercise
 * pressure, concentration, preparation, and recovery. */
export const setupStalemateBreaker: ScenarioSetup = (world, options) => {
  if (startAdjacentWars(world, 1) === 0) throw new Error("stalemate-breaker requires adjacent nations");
  for (const nation of world.nations) nation.nextWarDeclarationTick = Number.POSITIVE_INFINITY;
  const war = world.wars[0];
  const combatants = [war.nationAId, war.nationBId];
  const ownerByMesoId = buildOwnerByMesoId(world);
  const borderRegions = new Map(combatants.map((nationId) => [nationId, [] as typeof world.mesoRegions[number]["id"][]]));
  for (const meso of world.mesoRegions) {
    const owner = ownerByMesoId.get(meso.id);
    if (!owner || !combatants.includes(owner)) continue;
    if (meso.neighbors.some((neighbor) => {
      const neighborOwner = ownerByMesoId.get(neighbor.id);
      return neighborOwner && neighborOwner !== owner && combatants.includes(neighborOwner);
    })) borderRegions.get(owner)?.push(meso.id);
  }
  world.units = world.units.filter((unit) => !combatants.includes(unit.nationId) || unit.domain !== "land");
  const unitCount = options.quick ? 24 : 60;
  for (const nationId of combatants) {
    const nation = world.nations.find((candidate) => candidate.id === nationId);
    if (!nation) continue;
    for (let index = 0; index < unitCount; index += 1) {
      const positions = borderRegions.get(nationId) ?? [];
      world.units.push(createUnitForType(
        createUnitId(world.unitIdCounter++), nationId, positions[index % Math.max(1, positions.length)] ?? nation.capitalMesoId,
        index % 6 === 0 ? "Tank" : "Infantry",
      ));
    }
    nation.initialUnitCount = world.units.filter((unit) => unit.nationId === nationId).length;
  }
};
