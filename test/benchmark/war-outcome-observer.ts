import type { NationId } from "../../src/worldgen/nation";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import { getWarCasualties } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";

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
}
interface TrackedWar {
  war: WarState;
  outcome: WarOutcome;
}
export interface WarOutcomeReport {
  wars: WarOutcome[];
  campaignChanges: number;
  campaignChangeReasons: Record<string, number>;
  activeWarTicks: number;
}

/** Diagnostic-only neutral goals are fixed at first observation for both A/B arms.
 * They are a proxy, not evidence that a government's internal goal was rational. */
export function createWarOutcomeObserver() {
  const tracked = new Map<string, TrackedWar>();
  const revisions = new Map<NationId, number>();
  const report: WarOutcomeReport = { wars: [], campaignChanges: 0, campaignChangeReasons: {}, activeWarTicks: 0 };
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
      const { outcome, war } = item;
      if (outcome.endedAtTick !== null) continue;
      outcome.survived = world.nations.some((nation) => nation.id === outcome.nationId && nation.macroRegionIds.length > 0);
      outcome.objectiveHeld = outcome.survived && outcome.objectiveIds.length > 0 &&
        outcome.objectiveIds.every((id) => (world.occupation.mesoById.get(id) ?? owners.get(id)) === outcome.nationId);
      if (outcome.objectiveHeld && outcome.firstAchievedTick === null) outcome.firstAchievedTick = tick;
      outcome.casualties = getWarCasualties(war, outcome.nationId);
      outcome.netOwnedRegions = world.mesoRegions.filter((region) => owners.get(region.id) === outcome.nationId).length - outcome.openingRegionCount;
      if (!present.has(war)) outcome.endedAtTick = tick;
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
  const objectiveIds = !aggressor ? [...homeIds] : war.ultimatumRegionIds?.length
    ? [...war.ultimatumRegionIds] : border ? [border] : capital ? [capital] : [];
  const strength = (id: NationId) => world.units.filter((unit) => unit.domain === "land" && unit.nationId === id)
    .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  return { war, outcome: {
    key, nationId, opponentId, aggressor, startedAtTick: war.startedAtFastTick,
    observedAtTick: world.time.fastTick, endedAtTick: null,
    openingStrengthRatio: strength(nationId) / Math.max(1, strength(opponentId)),
    openingRegionCount: homeIds.length, objectiveIds,
    objectiveKind: aggressor ? "opening-limited-target" : "territorial-defense",
    firstAchievedTick: null, objectiveHeld: false, survived: true, casualties: 0, netOwnedRegions: 0,
  } };
}
