import "../../src/style.css";
import { createGame } from "../../src/app/create-game";
import { createSeededWorld } from "../helpers/seeded-world";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { findTradeRoute } from "../../src/sim/international-trade";
import { getRelation, getDiplomacyState, proposeTreaty } from "../../src/sim/diplomacy";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import { selectMapNation } from "../../src/render/map-view-state";
import { getNationName } from "../../src/sim/nation-identity";

// Prepared trusted neighbors, existing trained troops and an offensive war; starts paused.
const world = createSeededWorld({ seed: 822748319788, width: window.innerWidth, height: window.innerHeight, quick: true,
  config: { systems: { diplomacyEnabled: true, mobilizationEnabled: true, researchEnabled: false } } });
for (const nation of world.nations) { nation.resources.manpower = 100000; nation.resources.weapons = 1000; nation.resources.fuel = 1000; getDiplomacyState(world).influenceByNationId.set(nation.id, 100); }
updateSupplyAssessment(world);
const pair = getAdjacentNationPairs(world).find(([a, b]) => { const route = findTradeRoute(world, a, b); return route && !route.maritime; });
if (!pair) throw new Error("Scene needs connected neighbors");
const [donor, recipient] = pair, enemy = world.nations.find((nation) => nation.id !== donor && nation.id !== recipient).id;
const relation = getRelation(world, donor, recipient); relation.opinion = 80; relation.trust = 80;
if (!proposeTreaty(world, donor, recipient, "alliance")) throw new Error("Failed alliance setup");
world.units = world.units.filter((unit) => unit.nationId !== donor);
const nation = world.nations.find((nation) => nation.id === donor);
for (let index = 0; index < 8; index++) {
  const unit = createUnitForType(createUnitId(world.unitIdCounter++), donor, nation.capitalMesoId, "Infantry");
  world.units.push(unit); nation.resources.manpower -= unit.manpower; nation.resources.weapons -= 10;
}
nation.initialUnitCount = 8;
declareWar(world.wars, recipient, enemy, 0);
updateSupplyAssessment(world); selectMapNation(world, donor);
console.log(`Cooperation scene: donor ${getNationName(world, donor)}, recipient ${getNationName(world, recipient)}, enemy ${getNationName(world, enemy)}`);
createGame(document.getElementById("app"), { world, paused: true });
