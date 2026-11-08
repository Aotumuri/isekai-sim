import "../../src/style.css";
import { createGame } from "../../src/app/create-game";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { updateOccupation } from "../../src/sim/occupation";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { selectMapNation } from "../../src/render/map-view-state";
import { createSeededWorld } from "../helpers/seeded-world";
import { buildOwnerByMesoId, startAdjacentWars } from "../scenarios/scenario-utils";

// Uses the production renderer and real occupation logic; time starts paused.
const world = createSeededWorld({ width: window.innerWidth, height: window.innerHeight, quick: true });
world.settings = createSimulationSettings();
startAdjacentWars(world, 1);
const war = world.wars[0];
if (!war) throw new Error("Visual scene needs adjacent nations");
const owners = buildOwnerByMesoId(world);
const mesoById = new Map(world.mesoRegions.map((region) => [region.id, region]));
const targets = world.mesoRegions.filter((region) => region.type !== "sea" && owners.get(region.id) === war.nationBId &&
  region.neighbors.some((neighbor) => owners.get(neighbor.id) === war.nationAId));
// Extend the border bridgehead by one region so the pattern is visible at world scale.
const targetIds = new Set(targets.flatMap((region) => [region.id, ...region.neighbors.map((neighbor) => neighbor.id)]));
for (const id of targetIds) {
  if (owners.get(id) !== war.nationBId || mesoById.get(id)?.type === "sea") continue;
  world.units = world.units.filter((unit) => unit.regionId !== id);
  world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), war.nationAId, id, "Infantry"));
}
updateOccupation(world);
if (!world.occupation.mesoById.size) throw new Error("Visual scene failed to create occupation");
selectMapNation(world, war.nationBId);
const root = document.getElementById("app");
if (!root) throw new Error("Missing visual scene root");
createGame(root, { world, paused: true });
