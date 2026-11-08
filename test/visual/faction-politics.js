import "../../src/style.css";
import { createGame } from "../../src/app/create-game";
import { createSeededWorld } from "../helpers/seeded-world";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateDiplomaticRelations } from "../../src/sim/diplomacy";
import { updateFactions } from "../../src/sim/factions";
import { selectMapNation, setMapMode } from "../../src/render/map-view-state";
import { getNationName, getNationIdeology } from "../../src/sim/nation-identity";

// Observe 30 minutes of the actual diplomatic AI with combat and economics held still.
const world = createSeededWorld({ seed: 822748319788, width: window.innerWidth, height: window.innerHeight, quick: true,
  config: { nationTargetMacroRegionsPerNation: 1, systems: createSimulationSettings({ mobilizationEnabled: false, researchEnabled: false, tradeEnabled: false, armsAidEnabled: false }) } });
for (let second = 0; second <= 1800; second += 10) {
  world.time.slowTick = second; world.time.fastTick = second * 10; world.time.elapsedMs = second * 1000;
  updateDiplomaticRelations(world); updateFactions(world);
}
const capitalist = world.nations.find((nation) => nation.ideologyId === "capitalism") ?? world.nations[0];
selectMapNation(world, capitalist.id); setMapMode(world, "factions");
console.log(`Faction politics scene: ${world.nations.map((nation) => `${getNationName(world, nation.id)} (${getNationIdeology(world, nation.id).name})`).join(", ")}`);
createGame(document.getElementById("app"), { world, paused: true });
