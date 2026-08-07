import type { ScenarioSetup } from "./types";
import { setupCivilWar } from "./civil-war";
import {
  ensureLandUnitCount,
  forceOneOccupation,
  startAdjacentWars,
} from "./scenario-utils";

export const setupLateGame: ScenarioSetup = (world, options) => {
  ensureLandUnitCount(world, options.quick ? 240 : 600);
  startAdjacentWars(world, 5);
  setupCivilWar(world, options);

  const candidates = world.nations
    .filter((nation) => nation.macroRegionIds.length > 0)
    .sort((a, b) => a.macroRegionIds.length - b.macroRegionIds.length);
  const extinct = candidates[0];
  const recipient = candidates.find((nation) => nation.id !== extinct?.id);
  if (!extinct || !recipient) {
    throw new Error("late-game requires two active nations");
  }
  const transferredIds = new Set(extinct.macroRegionIds);
  for (const macro of world.macroRegions) {
    if (transferredIds.has(macro.id)) {
      macro.nationId = recipient.id;
    }
  }
  recipient.macroRegionIds = [...new Set([...recipient.macroRegionIds, ...transferredIds])];
  extinct.macroRegionIds = [];
  world.units = world.units.filter((unit) => unit.nationId !== extinct.id);
  world.wars = world.wars.filter(
    (war) => war.nationAId !== extinct.id && war.nationBId !== extinct.id,
  );
  world.battles = world.battles.filter(
    (battle) =>
      battle.attackerNationId !== extinct.id && battle.defenderNationId !== extinct.id,
  );
  world.territoryVersion += 1;

  startAdjacentWars(world, 5);
  if (!forceOneOccupation(world)) {
    throw new Error("late-game scenario failed to create an occupation");
  }
};
