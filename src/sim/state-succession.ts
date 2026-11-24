import type { NationId } from "../worldgen/nation";
import { cancelIntegratedAmphibiousOperations } from "./amphibious";
import { returnArmsAidForGovernment } from "./arms-aid";
import { relationKey } from "./diplomacy";
import { prisonerGroupKey } from "./defeated-formations";
import { leaveFaction } from "./factions";
import { returnTradeEscrowForGovernment } from "./international-trade";
import { hasMilitaryAccess, revokeMilitaryAccess } from "./military-access";
import { allFieldUnits } from "./mobilization";
import type { NationRuntime } from "./nation-runtime";
import { EQUIPMENT_FAMILIES, FAMILY_RESEARCH_BRANCHES, getResearchPortfolio } from "./research";
import { hasPoliticalTurbulence } from "./simulation-settings";
import { getSubjectOverlord, updateSubjectGovernments } from "./subject-governments";
import { createTreasury } from "./treasury";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function getSubjectIntegrationIssue(world: WorldState, overlord: NationId, subject: NationId): string | undefined {
  if (!hasPoliticalTurbulence(world) || getSubjectOverlord(world, subject) !== overlord) return "An active subject government is required.";
  if (overlord === subject) return "A government cannot integrate itself.";
  const nation = world.nations.find(({ id }) => id === subject)!;
  const state = nation.governance;
  const consent = nation.subjectGovernment?.integrationConsentAt === world.time.fastTick &&
    world.time.fastTick - nation.subjectGovernment.establishedAtFastTick >= 1800;
  if (!consent && nation.subjectGovernment?.selfGovernment) return "The self-government charter requires agreement by both cabinets.";
  if (!consent && (state?.policy !== "assimilation" || world.time.slowTick - state.since < 180 || state.alignment < 0.72)) return "Common administration requires 1,800 days and 72% alignment with the overlord’s administrative culture.";
  const sponsorCulture = world.nations.find(({ id }) => id === overlord)?.identityGovernment?.favored.culture;
  if (!consent && state?.alignmentCulture && sponsorCulture && state.alignmentCulture !== sponsorCulture) return "The overlord’s new administrative culture is awaiting an alignment review.";
  const relation = world.diplomacy?.relations.get(relationKey(overlord, subject));
  if ((state?.stability ?? nation.identityStability?.legitimacy ?? 0) < 55 || (nation.subjectGovernment?.autonomy ?? 0) > 65 || !relation || relation.trust < 45) return "Requires stability 55, autonomy pressure at most 65, and trust 45.";
  if (world.wars.some(({ nationAId, nationBId }) => [nationAId, nationBId].some((id) => id === overlord || id === subject))) return "Both governments must be at peace.";
  if (world.volunteers?.missions.some((mission) => (mission.donorId === subject || mission.recipientId === subject) &&
    !["completed", "lost", "integrated"].includes(mission.status))) return "The subject has volunteer units in transit or on duty.";
  if (world.macroRegions.some((macro) => macro.nationId === subject && macro.mesoRegionIds.some((id) => {
    const occupier = world.occupation.mesoById.get(id);
    return occupier && occupier !== subject;
  }))) return "The subject must control its territory.";
}

function inheritStocks(former: NationRuntime, successor: NationRuntime): void {
  for (const key of Object.keys(former.resources) as (keyof NationRuntime["resources"])[]) {
    const stock = former.resources[key];
    if (stock === undefined) continue;
    successor.resources[key] = (successor.resources[key] ?? 0) + stock;
    former.resources[key] = 0;
  }
  if (former.treasury) {
    const treasury = successor.treasury ??= createTreasury(0);
    treasury.balance += former.treasury.balance;
    former.treasury.balance = 0;
  }
  if (former.food) {
    const food = successor.food ??= { stock: 0, harvest: 0, demand: 0, rationCoverage: 1, shortageCycles: 0, deaths: 0 };
    food.stock += former.food.stock;
    former.food.stock = 0;
  }
}

function inheritCompletedResearch(world: WorldState, former: NationRuntime, successor: NationRuntime): void {
  const root = world.research?.byNationId.get(former.id);
  if (!root) return;
  const legacy = !root.programs;
  for (const family of EQUIPMENT_FAMILIES) {
    if (!legacy && family !== "Infantry" && !root.programs?.[family]) continue;
    const from = getResearchPortfolio(world, former.id, family);
    const to = getResearchPortfolio(world, successor.id, family);
    for (const branch of FAMILY_RESEARCH_BRANCHES[family]) if (from.levels[branch] > to.levels[branch]) {
      to.levels[branch] = from.levels[branch];
      to.progress[branch] = 0;
    }
  }
}

function inheritForces(world: WorldState, former: NationRuntime, successor: NationRuntime): void {
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const access = world.militaryAccess;
  const field = new Set(world.units);
  for (const unit of allFieldUnits(world)) {
    if (unit.nationId !== former.id) continue;
    unit.nationId = successor.id;
    unit.amphibiousEmbarkRequested = false;
    unit.amphibiousLandRequested = false;
    unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0;
    access?.orders.delete(unit.id);
    world.playerNation?.navalOrders.delete(unit.id);
    if (!field.has(unit)) continue;
    const owner = owners.get(unit.regionId);
    if (owner && owner !== successor.id && !hasMilitaryAccess(world, successor.id, owner)) {
      if (unit.domain === "land") unit.regionId = successor.capitalMesoId;
      else {
        const port = regions.get(unit.regionId);
        const sea = port?.neighbors.find(({ id }) => regions.get(id)?.type === "sea");
        if (sea) unit.regionId = sea.id;
      }
    }
    for (const cargo of unit.cargoUnits) cargo.regionId = unit.regionId;
  }

  // Keep routed formations in recovery, rehoming their rally point if needed.
  for (const retreat of world.defeatedFormations?.withdrawals.values() ?? []) {
    if (retreat.unit.nationId !== former.id) continue;
    retreat.unit.nationId = successor.id;
    if (owners.get(retreat.destination) !== successor.id) retreat.destination = successor.capitalMesoId;
    if (retreat.arrived) retreat.unit.regionId = retreat.destination;
  }
  former.unitRoles.defenseUnitIds = [];
  former.unitRoles.occupationUnitIds = [];
}

function inheritPrisoners(world: WorldState, former: NationRuntime, successor: NationRuntime): void {
  const groups = world.defeatedFormations?.prisoners;
  if (!groups) return;
  for (const [key, group] of [...groups]) {
    if (group.home !== former.id && group.belligerent !== former.id && group.captor !== former.id) continue;
    groups.delete(key);
    if (group.home === former.id) group.home = successor.id;
    if (group.belligerent === former.id) group.belligerent = successor.id;
    if (group.captor === former.id) group.captor = successor.id;
    const nextKey = prisonerGroupKey(group.captor, group.belligerent, group.home);
    const existing = groups.get(nextKey);
    if (!existing) groups.set(nextKey, group);
    else {
      existing.manpower += group.manpower;
      existing.releaseAt = existing.releaseAt === undefined || group.releaseAt === undefined
        ? undefined : Math.max(existing.releaseAt, group.releaseAt);
    }
  }
}

function settleAgreements(world: WorldState, former: NationRuntime, successor: NationRuntime): void {
  leaveFaction(world, former.id, "government integrated");
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    if (relation.nationAId !== former.id && relation.nationBId !== former.id) continue;
    relation.treaties = [];
    relation.crisis = null;
    delete relation.defensePact;
  }
  for (const grant of world.militaryAccess?.grants ?? []) {
    if (grant.hostId === former.id || grant.guestId === former.id) {
      revokeMilitaryAccess(world, grant.hostId, grant.guestId, "government integrated");
    }
  }
  if (world.resourceReparations) {
    world.resourceReparations = world.resourceReparations.filter((treaty) => {
      if (treaty.payerId === former.id) treaty.payerId = successor.id;
      if (treaty.recipientId === former.id) treaty.recipientId = successor.id;
      return treaty.payerId !== treaty.recipientId;
    });
  }
  delete former.subjectGovernment;
  if (world.militaryAccess) world.militaryAccess.version++;
  updateSubjectGovernments(world);
}

/** Called once, after the complete peaceful transfer has been validated and applied. */
export function inheritIntegratedGovernment(world: WorldState, former: NationRuntime, successor: NationRuntime): void {
  returnTradeEscrowForGovernment(world, former.id);
  returnArmsAidForGovernment(world, former.id);
  inheritStocks(former, successor);
  inheritCompletedResearch(world, former, successor);
  cancelIntegratedAmphibiousOperations(world, former.id);
  inheritForces(world, former, successor);
  inheritPrisoners(world, former, successor);
  settleAgreements(world, former, successor);
  former.integratedIntoId = successor.id;
}
