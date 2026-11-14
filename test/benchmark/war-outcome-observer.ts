import type { NationId } from "../../src/worldgen/nation";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import { getWarCasualties } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getBaseTerritorialValue } from "../../src/sim/territorial-value";

export const WAR_OUTCOME_SCHEMA = 2;

export interface WarOutcome {
  key: string;
  nationId: NationId;
  opponentId: NationId;
  aggressor: boolean;
  startedAtTick: number;
  observedAtTick: number;
  endedAtTick: number | null;
  openingStrengthRatio: number;
  openingRegionCount: number;
  objectiveIds: MesoRegionId[];
  objectiveKind: "opening-limited-target" | "territorial-defense";
  firstAchievedTick: number | null;
  objectiveHeld: boolean;
  survived: boolean;
  casualties: number;
  netOwnedRegions: number;
  openingTerritorialValue: number;
  opponentTerritorySecuredValue: number;
  homelandLostValue: number;
}
interface TrackedWar {
  war: WarState;
  outcome: WarOutcome;
  homeValues: Map<MesoRegionId, number>;
  opponentValues: Map<MesoRegionId, number>;
  territoryVersion: number;
}
export interface WarOutcomeReport {
  schemaVersion: number;
  wars: WarOutcome[];
  campaignChanges: number;
  campaignChangeReasons: Record<string, number>;
  activeWarTicks: number;
  operationEndReasons: Record<string, number>;
}

/** Diagnostic-only neutral goals are fixed at first observation for both A/B arms.
 * They are a proxy, not evidence that a government's internal goal was rational. */
export function createWarOutcomeObserver() {
  const tracked = new Map<string, TrackedWar>();
  const revisions = new Map<NationId, number>();
  const seenOperations = new Set<string>();
  const report: WarOutcomeReport = { schemaVersion: WAR_OUTCOME_SCHEMA, wars: [], campaignChanges: 0,
    campaignChangeReasons: {}, activeWarTicks: 0, operationEndReasons: {} };
  let previousTick = -1;
  let previouslyAtWar = false;
  function observe(world: WorldState): void {
    const owners = getOwnerByMesoId(world);
    const tick = world.time.fastTick;
    if (previousTick >= 0 && previouslyAtWar) report.activeWarTicks += tick - previousTick;
    previousTick = tick;
    previouslyAtWar = world.wars.length > 0;
    const present = new Set(world.wars);
    for (const war of world.wars) {
      for (const nationId of [war.nationAId, war.nationBId]) {
        const key = `${war.nationAId}:${war.nationBId}@${war.startedAtFastTick}:${nationId}`;
        if (!tracked.has(key)) tracked.set(key, openWar(world, war, nationId, key));
      }
    }
    for (const item of tracked.values()) {
      updateWarOutcome(world, item, owners, present.has(item.war));
    }
    for (const operation of world.offensiveOperations.operations) {
      if (!operation.completionReason || seenOperations.has(operation.id)) continue;
      seenOperations.add(operation.id);
      const reason = `${operation.outcome}:${operation.completionReason}`;
      report.operationEndReasons[reason] = (report.operationEndReasons[reason] ?? 0) + 1;
    }
    for (const campaign of world.warCampaigns?.byNationId.values() ?? []) {
      if (revisions.get(campaign.nationId) === campaign.revision) continue;
      // Count adoption separately from genuine changes after the first plan.
      if (revisions.has(campaign.nationId)) {
        report.campaignChanges += 1;
        report.campaignChangeReasons[campaign.reason] = (report.campaignChangeReasons[campaign.reason] ?? 0) + 1;
      }
      revisions.set(campaign.nationId, campaign.revision);
    }
    for (const id of revisions.keys()) {
      if (!world.warCampaigns?.byNationId.has(id)) revisions.delete(id);
    }
  }
  return { observe, result: (): WarOutcomeReport => ({ ...report, wars: [...tracked.values()].map((item) => item.outcome) }) };
}

function openWar(world: WorldState, war: WarState, nationId: NationId, key: string): TrackedWar {
  const owners = getOwnerByMesoId(world);
  const opponentId = nationId === war.nationAId ? war.nationBId : war.nationAId;
  const homeIds = world.mesoRegions.filter((region) => owners.get(region.id) === nationId).map((region) => region.id);
  const border = world.mesoRegions.filter((region) => owners.get(region.id) === opponentId &&
    region.neighbors.some((neighbor) => owners.get(neighbor.id) === nationId)).map((region) => region.id).sort()[0];
  const capital = world.nations.find((nation) => nation.id === opponentId)?.capitalMesoId;
  const aggressor = war.aggressorId === nationId;
  const snapshotValues = (id: NationId) => new Map(world.mesoRegions.filter((region) => owners.get(region.id) === id)
    .map((region) => [region.id, getBaseTerritorialValue(region, world.regionalPopulations?.get(region.id)?.size ?? 0)]));
  const homeValues = snapshotValues(nationId), opponentValues = snapshotValues(opponentId);
  const objectiveIds = !aggressor ? [...homeIds] : war.ultimatumRegionIds?.length
    ? [...war.ultimatumRegionIds] : border ? [border] : capital ? [capital] : [];
  const strength = (id: NationId) => world.units.filter((unit) => unit.domain === "land" && unit.nationId === id)
    .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  return { war, homeValues, opponentValues, territoryVersion: -1, outcome: {
    key, nationId, opponentId, aggressor, startedAtTick: war.startedAtFastTick,
    observedAtTick: world.time.fastTick, endedAtTick: null,
    openingStrengthRatio: strength(nationId) / Math.max(1, strength(opponentId)),
    openingRegionCount: homeIds.length, objectiveIds,
    objectiveKind: aggressor ? "opening-limited-target" : "territorial-defense",
    firstAchievedTick: null, objectiveHeld: false, survived: true, casualties: 0, netOwnedRegions: 0,
    openingTerritorialValue: [...homeValues.values()].reduce((sum, value) => sum + value, 0),
    opponentTerritorySecuredValue: 0, homelandLostValue: 0,
  } };
}

function updateWarOutcome(
  world: WorldState, item: TrackedWar, owners: ReadonlyMap<MesoRegionId, NationId>, present: boolean,
): void {
  const tick = world.time.fastTick;
      const { outcome, war } = item;
      if (outcome.endedAtTick !== null) return;
      outcome.survived = world.nations.some((nation) => nation.id === outcome.nationId && nation.macroRegionIds.length > 0);
      outcome.objectiveHeld = outcome.survived && outcome.objectiveIds.length > 0 &&
        outcome.objectiveIds.every((id) => (world.occupation.mesoById.get(id) ?? owners.get(id)) === outcome.nationId);
      if (outcome.objectiveHeld && outcome.firstAchievedTick === null) outcome.firstAchievedTick = tick;
      outcome.casualties = getWarCasualties(war, outcome.nationId);
      if (item.territoryVersion !== world.territoryVersion) {
        item.territoryVersion = world.territoryVersion;
        outcome.netOwnedRegions = world.mesoRegions.filter((region) => owners.get(region.id) === outcome.nationId).length - outcome.openingRegionCount;
        outcome.opponentTerritorySecuredValue = [...item.opponentValues].reduce((sum, [id, value]) => sum + (owners.get(id) === outcome.nationId ? value : 0), 0);
        outcome.homelandLostValue = [...item.homeValues].reduce((sum, [id, value]) => sum + (owners.get(id) !== outcome.nationId ? value : 0), 0);
      }
      if (!present) outcome.endedAtTick = tick;
}
