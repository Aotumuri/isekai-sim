import { isNationActive } from "../../src/sim/nation-active";
import type { WorldState } from "../../src/sim/world-state";
import type { WorldSummary } from "../benchmark/types";

export function summarizeWorld(world: WorldState): WorldSummary {
  const activeNations = world.nations.filter(isNationActive).length;
  return {
    nations: world.nations.length,
    activeNations,
    extinctNations: world.nations.length - activeNations,
    units: world.units.length,
    landUnits: world.units.filter((unit) => unit.domain === "land").length,
    wars: world.wars.length,
    battles: world.battles.length,
    occupations: world.occupation.mesoById.size,
    microRegions: world.microRegions.length,
    mesoRegions: world.mesoRegions.length,
    macroRegions: world.macroRegions.length,
    territoryVersion: world.territoryVersion,
    occupationVersion: world.occupation.version,
    buildingVersion: world.buildingVersion,
  };
}
