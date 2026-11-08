import { world, a, target } from "./territorial-settlement";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getRelation } from "../../src/sim/diplomacy";
const owner = getOwnerByMesoId(world).get(target.id);
getRelation(world, a, owner).crisis = {
  aggressorId: a, demand: "territory", regionIds: [target.id],
  openedAtSlowTick: world.time.slowTick, deadlineSlowTick: world.time.slowTick + 60,
};
