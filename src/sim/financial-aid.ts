import type { NationId } from "../worldgen/nation";
import { getRelation, hasTreaty } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { areSubjectPartners } from "./subject-governments";
import { isTradeEmbargoed } from "./trade-embargo";
import { spendTreasury } from "./treasury";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";

export const FINANCIAL_AID = 25;

export function getFinancialAidIssue(world: WorldState, donorId: NationId, recipientId: NationId): string | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || donorId === recipientId ||
    findWar(world.wars, donorId, recipientId) || isTradeEmbargoed(world, donorId, recipientId)) return "Financial aid requires peaceful diplomatic access.";
  const donor = world.nations.find((nation) => nation.id === donorId);
  const recipient = world.nations.find((nation) => nation.id === recipientId);
  if (!donor?.treasury || !recipient?.treasury || !isNationActive(donor) || !isNationActive(recipient)) return "Both nations need active treasuries.";
  if (!areFactionPartners(world, donorId, recipientId) && !areSubjectPartners(world, donorId, recipientId) &&
    !hasTreaty(world, donorId, recipientId, "alliance")) return "Select an ally, faction partner or subject.";
  if ((donor.treasury.nextAidTick ?? 0) > world.time.slowTick) return "The donor recently sent financial aid.";
  if (donor.treasury.balance < FINANCIAL_AID + 10) return "The donor needs enough cash to keep a reserve of 10.";
  return null;
}

export function sendFinancialAid(world: WorldState, donorId: NationId, recipientId: NationId): boolean {
  if (getFinancialAidIssue(world, donorId, recipientId)) return false;
  const donor = world.nations.find((nation) => nation.id === donorId)!.treasury!;
  const recipient = world.nations.find((nation) => nation.id === recipientId)!.treasury!;
  if (!spendTreasury(donor, "aid", FINANCIAL_AID)) return false;
  donor.nextAidTick = world.time.slowTick + 60;
  recipient.balance += FINANCIAL_AID;
  const relation = getRelation(world, donorId, recipientId);
  relation.trust = Math.min(100, relation.trust + 2);
  recordSimulationEvent(world, { category: "aid", nationIds: [donorId, recipientId],
    message: `${donorId} granted ${FINANCIAL_AID} cash to ${recipientId}.` });
  return true;
}
