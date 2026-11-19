import { creditReturnedPrisoners, prisonerGroupKey } from "./defeated-formations";
import { getRelation } from "./diplomacy";
import { getWarFatigue } from "./diplomatic-peace";
import { isNationActive } from "./nation-active";
import { getNationCharacter } from "./nation-character";
import { hasMinimumPeaceAge } from "./peace-maturity";
import { getManualGovernmentId } from "./player-nation";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

const EXCHANGE_INTERVAL = 30;

function willingToExchange(world: WorldState, nation: NationId, opponent: NationId): boolean {
  return getNationCharacter(world, nation).cooperation >= 0.5 || getWarFatigue(world, nation, opponent) >= 35;
}

export function updatePrisonerExchanges(world: WorldState): void {
  const state = world.defeatedFormations;
  if (!state?.prisoners.size || world.settings?.defeatedFormationsEnabled === false ||
    world.time.slowTick % EXCHANGE_INTERVAL !== 0 || getWarDeclarationMode(world) !== "diplomacy") return;
  const manual = getManualGovernmentId(world);
  const active = new Map(world.nations.filter(isNationActive).map((nation) => [nation.id, nation]));
  for (const war of world.wars) {
    const a = active.get(war.nationAId), b = active.get(war.nationBId);
    if (!a || !b || a.id === manual || b.id === manual ||
      !hasMinimumPeaceAge(world.time.fastTick, war.startedAtFastTick)) continue;
    // This bilateral agreement covers each country's own personnel. Third-party
    // volunteers retain their existing route home after the hostilities end.
    const heldByA = prisonerGroupKey(a.id, b.id, b.id);
    const heldByB = prisonerGroupKey(b.id, a.id, a.id);
    const inA = state.prisoners.get(heldByA), inB = state.prisoners.get(heldByB);
    if (!inA || !inB) continue;
    const amount = Math.min(inA.manpower, inB.manpower);
    if (amount < 1 || !willingToExchange(world, a.id, b.id) || !willingToExchange(world, b.id, a.id)) continue;
    creditReturnedPrisoners(state, a, amount);
    creditReturnedPrisoners(state, b, amount);
    inA.manpower -= amount;
    inB.manpower -= amount;
    if (inA.manpower === 0) state.prisoners.delete(heldByA);
    if (inB.manpower === 0) state.prisoners.delete(heldByB);
    const relation = getRelation(world, a.id, b.id);
    relation.trust = Math.min(100, relation.trust + 2);
    recordSimulationEvent(world, { category: "military", nationIds: [a.id, b.id],
      message: `${a.id} and ${b.id} exchanged ${Math.round(amount)} prisoners each while hostilities continued.` });
  }
}
