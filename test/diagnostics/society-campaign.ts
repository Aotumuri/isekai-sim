import { allFieldUnits } from "../../src/sim/mobilization";
import { getOwnerByMesoId, getAdjacentNationPairs } from "../../src/sim/world-cache";
import { proposeTerritorialExchange, respondToTerritorialOffer } from "../../src/sim/territorial-deals";
import { updateTerritorialClaims } from "../../src/sim/territorial-claims";
import { getDiplomacyState } from "../../src/sim/diplomacy";
import { createSeededWorld } from "../helpers/seeded-world";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { RESEARCH_BRANCHES } from "../../src/sim/research";
import { isNationActive } from "../../src/sim/nation-active";
import { getNationIdeology } from "../../src/sim/nation-identity";

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name), value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const ticks = arg("--ticks", 12000), requestedSeed = process.argv.includes("--seed") ? arg("--seed", 101) : null;
for (const seed of requestedSeed ? [requestedSeed] : [101, 695919685365, 822748319788]) {
  const settings = createSimulationSettings({ diplomacyEnabled: !process.argv.includes("--legacy") });
  const world = createSeededWorld({ seed, width: 960, height: 540, quick: true, config: { systems: settings } });
  world.settings = settings;
  const originalRegions = new Set(world.macroRegions.flatMap((macro) => macro.mesoRegionIds));
  if (process.argv.includes("--territorial-scene")) {
    const [a, b] = getAdjacentNationPairs(world)[0];
    world.time.slowTick = 600; world.time.fastTick = 6000; world.time.elapsedMs = 600000;
    updateTerritorialClaims(world);
    const owners = getOwnerByMesoId(world);
    const parcel = (owner: typeof a) => [...owners].find(([id, nation]) => nation === owner && id !== world.nations.find((item) => item.id === owner)!.capitalMesoId)![0];
    getDiplomacyState(world).influenceByNationId.set(a, 100);
    const offer = proposeTerritorialExchange(world, a, b, [parcel(a)], [parcel(b)]);
    if (!offer || !respondToTerritorialOffer(world, b, offer.id, true)) throw new Error("Failed territorial campaign setup");
  }
  let peakArmy = 0, peakStrain = 0, peakFactions = 0, peakMultiNationBlocs = 0;
  let treatyPeak = 0, levels = 0, actualBattles = 0, last = 0;
  const result = withMutedSimulationLogs(() => {
    for (let part = 0; part < ticks; part += 100) {
      runSimulation(world, { ticks: Math.min(100, ticks - part) });
      const activeTreaties = [...(world.diplomacy?.relations.values() ?? [])].reduce((sum, relation) =>
        sum + relation.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick).length, 0);
      treatyPeak = Math.max(treatyPeak, activeTreaties);
      actualBattles += world.battles.length;
      for (const nation of world.nations) for (const amount of Object.values(nation.resources)) {
        if (!Number.isFinite(amount) || amount < -1e-8) throw new Error(`Invalid resource balance at tick ${world.time.fastTick}`);
      }
      const militaryCounts = new Map<string, number>();
      for (const unit of allFieldUnits(world)) if (unit.domain === "land") militaryCounts.set(unit.nationId, (militaryCounts.get(unit.nationId) ?? 0) + 1);
      for (const count of militaryCounts.values()) peakArmy = Math.max(peakArmy, count);
      for (const item of world.mobilization?.byNationId.values() ?? []) {
        if (![item.burden, item.readiness, item.continuousDeployment].every(Number.isFinite) || item.burden < 0 || item.burden > 100 || item.readiness < 0 || item.readiness > 1) throw new Error("Invalid mobilization state");
        peakStrain = Math.max(peakStrain, item.burden);
      }
      for (const mission of world.volunteers?.missions ?? []) {
        if (new Set(mission.unitIds).size !== mission.unitIds.length || mission.transitUnits.some((unit) => unit.volunteerMissionId !== mission.id || !mission.unitIds.includes(unit.id))) throw new Error("Invalid volunteer inventory");
        if (["completed", "lost", "integrated"].includes(mission.status) && mission.transitUnits.length) throw new Error("Terminal volunteer mission holds troops");
      }
      if ((world.volunteers?.missions.length ?? 0) > 40 || (world.alliedWarRequests?.requests.length ?? 0) > 40 || (world.militaryAccess?.grants.length ?? 0) > 128) throw new Error("Unbounded military cooperation history");
      const parcels = world.macroRegions.flatMap((macro) => macro.mesoRegionIds);
      if (parcels.length !== originalRegions.size || new Set(parcels).size !== parcels.length || parcels.some((id) => !originalRegions.has(id))) throw new Error("Lost or duplicated territory");
      for (const nation of world.nations) {
        const macros = world.macroRegions.filter((macro) => macro.nationId === nation.id).map((macro) => macro.id);
        if (macros.length !== nation.macroRegionIds.length || macros.some((id) => !nation.macroRegionIds.includes(id))) throw new Error("Invalid province ownership index");
      }
      for (const histories of world.territorialClaims?.history.values() ?? []) for (const memory of histories.values()) {
        if (!Number.isFinite(memory.heldTicks) || memory.heldTicks < 0 || !Number.isFinite(memory.attachment) || memory.attachment < 0 || memory.attachment > 100) throw new Error("Invalid territorial attachment");
      }
      if ((world.territorialDeals?.offers.length ?? 0) > 40) throw new Error("Unbounded territorial offers");
      const allUnits = [...world.units.flatMap((unit) => [unit, ...unit.cargoUnits]), ...(world.volunteers?.missions.flatMap((mission) => mission.transitUnits) ?? [])];
      if (new Set(allUnits.map((unit) => unit.id)).size !== allUnits.length) throw new Error("Duplicate unit ownership");
      for (const relation of world.diplomacy?.relations.values() ?? []) {
        if (!Number.isFinite(relation.opinion) || relation.opinion < -100 || relation.opinion > 100 ||
          ![relation.trust, relation.tension, relation.grievance].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error("Invalid diplomatic relation");
        if (new Set(relation.treaties.map((treaty) => treaty.type)).size !== relation.treaties.length) throw new Error("Duplicate treaty");
      }
      for (const portfolio of world.research?.byNationId.values() ?? []) for (const branch of RESEARCH_BRANCHES) {
        if (!Number.isInteger(portfolio.levels[branch]) || portfolio.levels[branch] < 0 || portfolio.levels[branch] > 10 ||
          !Number.isFinite(portfolio.progress[branch]) || portfolio.progress[branch] < 0) throw new Error("Invalid research progress");
      }
      if (world.events && world.events.length > 200) throw new Error("Unbounded event history");
      peakFactions = Math.max(peakFactions, world.factions?.factions.length ?? 0);
      peakMultiNationBlocs = Math.max(peakMultiNationBlocs, world.factions?.factions.filter((faction) => faction.memberIds.length >= 2).length ?? 0);
      const members = new Set<string>();
      for (const faction of world.factions?.factions ?? []) {
        if (!faction.memberIds.length || !faction.memberIds.includes(faction.leaderId)) throw new Error("Invalid faction leader");
        for (const id of faction.memberIds) {
          if (members.has(id) || world.factions?.factionByNationId.get(id) !== faction ||
            !faction.charter.allowedIdeologyIds.includes(getNationIdeology(world, id).id)) throw new Error("Invalid faction membership");
          members.add(id);
        }
      }
      if (members.size !== (world.factions?.factionByNationId.size ?? 0)) throw new Error("Stale faction membership index");
      if (world.factions) for (const id of world.factions.membershipSince.keys()) if (!members.has(id)) throw new Error("Stale faction loyalty record");
      last = world.time.fastTick;
    }
    return last;
  });
  for (const portfolio of world.research?.byNationId.values() ?? []) levels += RESEARCH_BRANCHES.reduce((sum, branch) => sum + portfolio.levels[branch], 0);
  console.log(JSON.stringify({ seed, ticks: result, activeNations: world.nations.filter(isNationActive).length,
    diplomacy: world.settings.diplomacyEnabled, legacyDeclarations: world.warIntent.declarations, declarations: world.diplomacy?.declarations ?? 0,
    crises: world.diplomacy?.crisesOpened ?? 0, resolvedCrises: world.diplomacy?.crisesResolved ?? 0,
    peaceAgreements: world.diplomacy?.peaceAgreements ?? 0, defensiveInterventions: world.diplomacy?.defensiveInterventions ?? 0,
    treatyPeak, tradeDeliveries: world.internationalTrade?.delivered ?? 0, aidDeliveries: world.diplomacy?.aidDeliveries ?? 0,
    researchLevels: levels, retrofits: world.research?.retrofits ?? 0, licenses: world.research?.licensesShared ?? 0,
    territorialOffers: world.territorialDeals?.offers.length ?? 0, territorialSettlements: world.territorialDeals?.offers.filter((offer) => offer.status === "accepted").length ?? 0,
    peakArmy, peakStrain, demobilizedUnits: [...(world.mobilization?.byNationId.values() ?? [])].reduce((sum, item) => sum + item.demobilized, 0),
    militaryAccessGrants: world.militaryAccess?.grants.filter((grant) => grant.revokedAtSlowTick === undefined).length ?? 0, alliedRequestsAccepted: world.alliedWarRequests?.requests.filter((request) => request.status === "accepted").length ?? 0,
    volunteerMissions: world.volunteers?.missions.length ?? 0, volunteersReturned: world.volunteers?.missions.reduce((sum, mission) => sum + mission.returnedUnits, 0) ?? 0,
    peakFactions, peakMultiNationBlocs, factionDefections: world.factions?.aiDefections ?? 0,
    factions: world.factions?.factions.length ?? 0, factionMembers: world.factions?.factionByNationId.size ?? 0,
    factionInterventions: world.factions?.interventions ?? 0, battleSamples: actualBattles, eventCount: world.events?.length ?? 0 }));
}
