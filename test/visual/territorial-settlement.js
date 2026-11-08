import "../../src/style.css";
import { createGame } from "../../src/app/create-game";
import { createSeededWorld } from "../helpers/seeded-world";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { updateTerritorialClaims } from "../../src/sim/territorial-claims";
import { getDiplomacyState } from "../../src/sim/diplomacy";
import { getNationalMilitaryStrength } from "../../src/sim/diplomatic-crises";
import { selectMapNation } from "../../src/render/map-view-state";

const world = createSeededWorld({ seed: 101, width: window.innerWidth, height: window.innerHeight, quick: true });
world.settings = createSimulationSettings();
updateSupplyAssessment(world); updateStrategicThreatObservation(world);
const exposure = world.strategicThreatObservation.exposures.find((item) => item.landAdjacent);
if (!exposure) throw new Error("Scene needs an adjacent border");
const a = exposure.observerNationId, b = exposure.threatNationId;
const target = world.mesoRegions.find((region) => getOwnerByMesoId(world).get(region.id) === b &&
  region.id !== world.nations.find((nation) => nation.id === b).capitalMesoId &&
  region.neighbors.some((neighbor) => getOwnerByMesoId(world).get(neighbor.id) === a));
if (!target) throw new Error("Scene needs a disputed district");
if (!transferTerritories(world, [{ from: b, to: a, regionIds: [target.id] }], "unilateral")) throw new Error("Failed historic cession");
world.time.slowTick += 600;
world.time.elapsedMs = world.time.slowTick * 1000;
world.time.fastTick = world.time.slowTick * 10;
updateTerritorialClaims(world);
if (!transferTerritories(world, [{ from: a, to: b, regionIds: [target.id] }], "unilateral")) throw new Error("Failed historic seizure");
const ratio = getNationalMilitaryStrength(world, b) / Math.max(1, getNationalMilitaryStrength(world, a));
for (const unit of world.units.filter((item) => item.nationId === a)) unit.manpower *= ratio * 1.2;
getDiplomacyState(world).influenceByNationId.set(a, 100);
selectMapNation(world, a);
console.log(`Territorial scene: ${target.id}, claimant ${a}, current owner ${b}`);
createGame(document.getElementById("app"), { world, paused: true });
