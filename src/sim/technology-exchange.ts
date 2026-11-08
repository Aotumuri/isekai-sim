import type { NationId } from "../worldgen/nation";
import { canSupportNation } from "./arms-aid";
import { getDiplomacyState, getRelation, hasTreaty, spendInfluence } from "./diplomacy";
import { changeResource } from "./international-trade";
import { isNationActive } from "./nation-active";
import { getResearchCost, getResearchPortfolio, getResearchState, RESEARCH_BRANCHES, type ResearchBranch } from "./research";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import type { WorldState } from "./world-state";

export function licenseTechnology(world: WorldState, licensorId: NationId, recipientId: NationId, branch: ResearchBranch): boolean {
  if (!world.settings?.researchEnabled || getWarDeclarationMode(world) !== "diplomacy" ||
    !RESEARCH_BRANCHES.includes(branch) || !canSupportNation(world, licensorId, recipientId)) return false;
  const relation = getRelation(world, licensorId, recipientId);
  if (relation.trust < 55 || (!hasTreaty(world, licensorId, recipientId, "alliance") && !hasTreaty(world, licensorId, recipientId, "trade"))) return false;
  const licensor = world.nations.find((nation) => nation.id === licensorId && isNationActive(nation));
  const recipient = world.nations.find((nation) => nation.id === recipientId && isNationActive(nation));
  if (!licensor || !recipient || recipient.resources.weapons < 12 || recipient.resources.steel < 8) return false;
  const state = getResearchState(world), key = `${licensorId}|${recipientId}|${branch}`;
  if ((state.licenseCooldowns.get(key) ?? -1) > world.time.slowTick) return false;
  const source = getResearchPortfolio(world, licensorId), target = getResearchPortfolio(world, recipientId);
  const gap = source.levels[branch] - target.levels[branch];
  if (gap <= 0 || target.levels[branch] >= 10) return false;
  const cost = getResearchCost(target, branch);
  const points = Math.min(cost * 0.3, 5 + gap * 6, cost - target.progress[branch] - 0.01);
  if (points < 1 || !spendInfluence(world, licensorId, 5)) return false;
  changeResource(recipient, "weapons", -4); changeResource(licensor, "weapons", 4);
  changeResource(recipient, "steel", -2);
  target.progress[branch] += points;
  state.licenseCooldowns.set(key, world.time.slowTick + 120); state.licensesShared += 1;
  recordSimulationEvent(world, { category: "research", nationIds: [licensorId, recipientId],
    message: `${licensorId} licensed ${branch} to ${recipientId} (+${points.toFixed(1)} research; recipient retains its own development program).` });
  return true;
}

export function updateTechnologyExchange(world: WorldState): void {
  if (!world.settings?.researchEnabled || getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getResearchState(world);
  if (world.time.slowTick - state.lastLicenseSlowTick < 60) return;
  state.lastLicenseSlowTick = world.time.slowTick;
  for (const [key, expires] of state.licenseCooldowns) if (expires <= world.time.slowTick) state.licenseCooldowns.delete(key);
  for (const relation of getDiplomacyState(world).relations.values()) {
    if (relation.crisis || relation.trust < 55) continue;
    for (const [a, b] of [[relation.nationAId, relation.nationBId], [relation.nationBId, relation.nationAId]] as const) {
      const source = getResearchPortfolio(world, a), target = getResearchPortfolio(world, b);
      const branch = [...RESEARCH_BRANCHES].sort((first, second) =>
        (source.levels[second] - target.levels[second]) - (source.levels[first] - target.levels[first]))[0]!;
      if (source.levels[branch] > target.levels[branch]) licenseTechnology(world, a, b, branch);
    }
  }
}
