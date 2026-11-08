import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { declareWar } from "../../src/sim/war-state";
import { WORLD_BALANCE } from "../../src/data/balance";
import { updateCivilWar } from "../../src/sim/civil-war";
import type { ScenarioSetup } from "./types";

export const setupCivilWar: ScenarioSetup = (world) => {
  const mesoById = new Map(world.mesoRegions.map((meso) => [meso.id, meso]));
  const candidate = world.nations.find((nation) => {
    if (nation.macroRegionIds.length <= 1) {
      return false;
    }
    const macroIds = new Set(nation.macroRegionIds);
    return world.macroRegions.some(
      (macro) =>
        macroIds.has(macro.id) &&
        macro.mesoRegionIds.some(
          (mesoId) =>
            mesoId !== nation.capitalMesoId && mesoById.get(mesoId)?.building === "city",
        ),
    );
  });
  if (!candidate) {
    throw new Error("civil-war requires a nation with multiple macros and a city");
  }
  const nationCountBefore = world.nations.length;
  candidate.warCooperation = WORLD_BALANCE.war.cooperation.min;
  // This benchmark starts with an already matured domestic crisis.
  const unrest = getDomesticUnrest(world, candidate.id);
  unrest.pressure = 100; unrest.lowSupportSeconds = WORLD_BALANCE.war.civilWar.minimumCrisisSeconds;
  if (!world.wars.some((war) => war.nationAId === candidate.id || war.nationBId === candidate.id)) {
    const enemy = world.nations.find((nation) => nation.id !== candidate.id && nation.macroRegionIds.length)!;
    declareWar(world.wars, candidate.id, enemy.id, world.time.fastTick);
  }
  updateCivilWar(world);
  if (world.nations.length <= nationCountBefore) {
    throw new Error("civil-war scenario failed to create a rebel nation");
  }
};
