import "../../src/style.css";
import { createGame } from "../../src/app/create-game";
import { createSeededWorld } from "../helpers/seeded-world";
import { updateMobilization, getMobilization, updateDemobilization } from "../../src/sim/mobilization";
import { updateWarCooperation } from "../../src/sim/war-cooperation";
import { updateProduction } from "../../src/sim/production";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { selectMapNation } from "../../src/render/map-view-state";

// An adequately funded nation keeps total mobilization in peacetime; real production builds its army.
const world = createSeededWorld({ seed: 822748319788, width: window.innerWidth, height: window.innerHeight, quick: true,
  config: { systems: { mobilizationEnabled: true, diplomacyEnabled: true } } });
const nation = world.nations[0];
for (const item of world.nations) { item.resources.manpower = 1000000; item.resources.weapons = 100000; item.resources.steel = 100000; }
getMobilization(world, nation.id).policy = "total";
for (let second = 0; second < 600; second++) {
  world.time.fastTick += 10; world.time.slowTick++; world.time.elapsedMs += 1000;
  for (let fast = 0; fast < 10; fast++) updateWarCooperation(world);
  updateMobilization(world); updateSupplyAssessment(world); updateProduction(world); updateDemobilization(world);
}
selectMapNation(world, nation.id);
createGame(document.getElementById("app"), { world, paused: true });
