import { createSeededWorld } from "./seeded-world";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { createFaction, joinFaction } from "../../src/sim/factions";
import { declareWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";

function assert(value: unknown): asserts value { if (!value) throw new Error("Exile scene requires allied states and surviving troops"); }

export function createExileWorld(width = 960, height = 540) {
  const world = createSeededWorld({ seed: 101, width, height, quick: true });
  world.settings = createSimulationSettings(); world.wars = []; world.battles = [];
  const [a, host, enemy, other] = world.nations;
  assert(a && host && enemy && other);
  for (const nation of world.nations) { nation.ideologyId = "capitalism"; getDiplomacyState(world).influenceByNationId.set(nation.id, 100); }
  const relation = getRelation(world, a.id, host.id); relation.opinion = relation.trust = 85;
  const faction = createFaction(world, a.id, { allowedIdeologyIds: ["capitalism"], defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: false })!;
  assert(joinFaction(world, host.id, faction.id));
  declareWar(world.wars, enemy.id, a.id, 0); declareWar(world.wars, enemy.id, host.id, 0);
  const homeland = [...getOwnerByMesoId(world)].filter(([, owner]) => owner === a.id).map(([id]) => id);
  for (const id of homeland) world.occupation.mesoById.set(id, enemy.id);
  world.occupation.version++;
  const escapees = world.units.filter((unit) => unit.nationId === a.id && unit.domain === "land").slice(0, 3);
  assert(escapees.length);
  for (const unit of escapees) { unit.regionId = host.capitalMesoId; unit.moveToId = unit.moveFromId = unit.moveTargetId = null; }
  return { world, a, host, enemy, other, faction, homeland, escapees };
}
