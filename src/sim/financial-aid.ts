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
    findWar(world.wars, donorId, recipientId) || isTradeEmbargoed(world, donorId, recipientId)) return "資金援助には平和な外交関係と通行可能な経路が必要です。";
  const donor = world.nations.find((nation) => nation.id === donorId);
  const recipient = world.nations.find((nation) => nation.id === recipientId);
  if (!donor?.treasury || !recipient?.treasury || !isNationActive(donor) || !isNationActive(recipient)) return "両国に利用可能な国庫が必要です。";
  if (!areFactionPartners(world, donorId, recipientId) && !areSubjectPartners(world, donorId, recipientId) &&
    !hasTreaty(world, donorId, recipientId, "alliance")) return "同盟国、同じ陣営の国、従属国のいずれかを選んでください。";
  if ((donor.treasury.nextAidTick ?? 0) > world.time.slowTick) return "最近、資金援助を送ったため、まだ再送できません。";
  if (donor.treasury.balance < FINANCIAL_AID + 10) return "援助後に資金10を残せるだけの国庫残高が必要です。";
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
    message: `${donorId}が${recipientId}に資金${FINANCIAL_AID}を援助しました。` });
  return true;
}
