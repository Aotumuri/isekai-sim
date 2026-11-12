import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { WorldState } from "../world-state";
import type { CampaignObjective } from "./state";
import { getPeaceBorderIssue } from "../peace-borders";
import { getOwnerByMesoId } from "../world-cache";
import { isNationActive } from "../nation-active";
import { getSubjectOverlord } from "../subject-governments";
import type { PeaceTerms } from "../war-negotiations";

export interface PoliticalObjective {
  purpose: "territorial-concession" | "decisive-victory" | "coercive-settlement" | "preserve-sovereignty";
  weaponTarget: number;
}

/** A military foothold is a means of applying pressure, not a legal enclave.
 * Snapshot the political purpose at adoption; never redefine success at peace. */
export function buildPoliticalObjective(
  world: WorldState, nation: NationId, opponent: NationId,
  regionIds: MesoRegionId[], offensive: boolean, rationale?: string,
): PoliticalObjective {
  if (!offensive) return { purpose: "preserve-sovereignty", weaponTarget: 0 };
  const enemy = world.nations.find((item) => item.id === opponent)!;
  const legal = regionIds.length > 0 && !regionIds.includes(enemy.capitalMesoId) &&
    !getPeaceBorderIssue(world, [{ from: opponent, to: nation, regionIds }]);
  if (!legal && (regionIds.includes(enemy.capitalMesoId) || rationale === "border-value")) {
    return { purpose: "decisive-victory", weaponTarget: 0 };
  }
  return legal ? { purpose: "territorial-concession", weaponTarget: 0 } : {
    purpose: "coercive-settlement", weaponTarget: Math.max(1, Math.min(15, Math.floor(enemy.resources.weapons * 0.15))),
  };
}

export function isPoliticalGoalSecured(world: WorldState, nation: NationId, goal: CampaignObjective): boolean {
  if (goal.political?.purpose === "preserve-sovereignty") return preservesCampaignSovereignty(world, nation);
  const owners = getOwnerByMesoId(world);
  if (goal.regionIds.length > 0 && goal.regionIds.every((id) => owners.get(id) === nation)) return true;
  if (goal.political?.purpose !== "coercive-settlement" && goal.political?.purpose !== "decisive-victory") return false;
  const started = Number(goal.warKey.slice(goal.warKey.lastIndexOf("@") + 1));
  return (world.warNegotiations?.settlements ?? []).some((settlement) => {
    if (settlement.atSlowTick * 10 < started ||
      ![settlement.a, settlement.b].includes(nation) || ![settlement.a, settlement.b].includes(goal.opponentId)) return false;
    const proposer = settlement.proposerId === nation;
    const terms = settlement.terms;
    const payment = proposer ? terms.demandedWeapons - terms.offeredWeapons : terms.offeredWeapons - terms.demandedWeapons;
    if (proposer && (terms.puppetTarget || terms.partition)) return true;
    return goal.political!.purpose === "coercive-settlement" &&
      (payment >= goal.political!.weaponTarget || proposer && !!terms.localSubject);
  });
}

/** Independence and the government's seat are distinct from intact borders.
 * Territory and local-subject losses retain their own costs in peace scoring. */
export function preservesCampaignSovereignty(world: WorldState, nation: NationId, terms?: PeaceTerms): boolean {
  const government = world.nations.find((item) => item.id === nation);
  if (!government || !isNationActive(government) || getSubjectOverlord(world, nation) ||
    terms?.puppetTarget || terms?.partition || terms?.demandedRegionIds.includes(government.capitalMesoId)) return false;
  return getOwnerByMesoId(world).get(government.capitalMesoId) === nation ||
    !!terms?.offeredRegionIds.includes(government.capitalMesoId);
}
