import "../../src/style.css";
import { createGame } from "../../src/app/create-game";
import { createExileWorld } from "../helpers/exile-world";
import { updateSurrender } from "../../src/sim/surrender";
import { updateExileGovernments } from "../../src/sim/exile-government";
import { selectMapNation, setMapMode } from "../../src/render/map-view-state";
const { world, a, host, homeland } = createExileWorld(window.innerWidth, window.innerHeight);
updateSurrender(world);
const record = world.exileGovernments.byNationId.get(a.id);
world.time.slowTick = record.arrivesAtSlowTick;
updateExileGovernments(world);
if (new URLSearchParams(window.location.search).has("restored")) {
  world.occupation.mesoById.set(homeland[0], host.id); world.occupation.version++;
  updateExileGovernments(world);
  world.time.slowTick = record.arrivesAtSlowTick;
  updateExileGovernments(world);
}
world.time.fastTick = world.time.slowTick * 10; world.time.elapsedMs = world.time.slowTick * 1000;
selectMapNation(world, a.id); setMapMode(world, "claims");
createGame(document.getElementById("app"), { world, paused: true });
