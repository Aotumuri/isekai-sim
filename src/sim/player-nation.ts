import type { MesoRegionId } from "../worldgen/meso-region";
import type { UnitId } from "./unit";
import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import type { WorldState } from "./world-state";

export interface PlayerNation {
  nationId: NationId;
  landOrders: Map<UnitId, MesoRegionId>;
  commandRevision: number;
  commandMode: "automatic" | "assisted" | "manual";
}

export function getPlayerNation(world: WorldState): PlayerNation | undefined {
  const player = world.playerNation;
  if (player && world.nations.some((nation) => nation.id === player.nationId && isNationActive(nation))) {
    return player;
  }
  delete world.playerNation;
}

export function enterPlayerNation(world: WorldState, nationId: NationId): boolean {
  if (!world.nations.some((nation) => nation.id === nationId && isNationActive(nation))) return false;
  world.playerNation = { nationId, commandMode: "automatic", landOrders: new Map(), commandRevision: 0 };
  return true;
}

export function leavePlayerNation(world: WorldState): void {
  delete world.playerNation;
}
