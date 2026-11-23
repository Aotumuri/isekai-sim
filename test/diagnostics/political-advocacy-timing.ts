import assert from "node:assert/strict";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import type { SimulationCounterName } from "../../src/sim/instrumentation";
import { DAYS_PER_SLOW_TICK } from "../../src/sim/time";
import { stepSimulationDay } from "../../src/sim/update";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { createSeededWorld } from "../helpers/seeded-world";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

/**
 * Measures whether regional demands live long enough to meet a foreign advocacy
 * evaluation pass. The engine evaluates advocacy every 60 slow ticks (600 days) and
 * reviews a regional demand every 10 slow ticks (100 days), so this diagnostic
 * records each demand's lifetime and how many evaluation passes it overlapped.
 *
 * Usage: SCENARIO=quick|medium|scale political-advocacy-timing.ts SEED DAYS [SEED DAYS ...]
 */

const args = process.argv.slice(2);
assert(args.length >= 2 && args.length % 2 === 0, "Usage: political-advocacy-timing.ts SEED DAYS [SEED DAYS ...]");
const scenario = process.env.SCENARIO ?? "quick";
assert(["quick", "medium", "scale", "dense"].includes(scenario), "SCENARIO must be quick, medium, scale, or dense");

const LIVE = new Set(["demand", "deferred", "offer"]);
const TERMINAL = new Set(["agreed", "rejected", "withdrawn", "violated"]);
const EVALUATION_INTERVAL = 60;
const REVIEW_INTERVAL = 10;
const WARMUP = 240;

interface Track {
  id: MesoRegionId;
  owner: NationId;
  opened: number;
  evaluations: number;
  reviews: number;
  foreignEver: boolean;
  closed?: number;
  closeStatus?: string;
}

interface Closed {
  id: string;
  owner: string;
  openedDay: number;
  lifetimeDays: number;
  evaluations: number;
  reviews: number;
  foreignEver: boolean;
  status: string;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

for (let pair = 0; pair < args.length; pair += 2) {
  const seed = Number(args[pair]), days = Number(args[pair + 1]);
  assert(Number.isSafeInteger(seed) && seed >= 0);
  assert(Number.isSafeInteger(days) && days > 0);
  const settings = createSimulationSettings({
    warCampaignEnabled: true, politicalTurbulenceEnabled: true, defeatedFormationsEnabled: true,
  });
  const world = withMutedSimulationLogs(() => createSeededWorld({
    seed, quick: scenario === "quick", config: {
      systems: settings,
      ...(scenario === "scale" || scenario === "dense" ? {
        nationTargetMacroRegionsPerNation: 1,
        nationMacroRegionSizeRange: scenario === "dense" ? { min: 2, max: 4 } : { min: 7, max: 11 },
      } : {}),
    },
  }));
  const counters: Partial<Record<SimulationCounterName, number>> = {};
  world.instrumentation = {
    recordDuration() {},
    incrementCounter(name, amount = 1) { counters[name] = (counters[name] ?? 0) + amount; },
  };
  const tracks = new Map<MesoRegionId, Track>();
  const closed: Closed[] = [];
  let evaluationPasses = 0, evaluationPassesWithLiveDemand = 0, liveDemandEvaluations = 0;
  let reviewPasses = 0, liveDemandReviews = 0;

  const close = (track: Track, status: string, now: number) => {
    if (track.closed !== undefined) return;
    track.closed = now;
    track.closeStatus = status;
    closed.push({
      id: track.id, owner: track.owner, openedDay: track.opened * DAYS_PER_SLOW_TICK,
      lifetimeDays: (now - track.opened) * DAYS_PER_SLOW_TICK, evaluations: track.evaluations,
      reviews: track.reviews, foreignEver: track.foreignEver, status,
    });
  };

  // Simulation battle logs use console.info. Silence them so the diagnostic emits
  // parseable JSON without changing any simulation behavior.
  const log = console.info;
  console.info = () => undefined;
  try {
    for (let day = 1; day <= days; day++) {
      stepSimulationDay(world);
      if (world.time.fastTick % DAYS_PER_SLOW_TICK !== 0) continue;
      const now = world.time.slowTick;
      const evaluation = now >= WARMUP && now % EVALUATION_INTERVAL === 0;
      const review = now >= WARMUP && now % REVIEW_INTERVAL === 0;
      let liveThisPass = 0;
      const present = new Set<MesoRegionId>();
      for (const [id, talks] of world.regionalNegotiations ?? []) {
        present.add(id);
        let track = tracks.get(id);
        if (!track || track.owner !== talks.owner) {
          track = { id, owner: talks.owner, opened: now, evaluations: 0, reviews: 0, foreignEver: false };
          tracks.set(id, track);
        }
        if (talks.foreign) track.foreignEver = true;
        if (LIVE.has(talks.status)) {
          liveThisPass++;
          if (evaluation) {
            track.evaluations++;
            liveDemandEvaluations++;
          }
          if (review) {
            track.reviews++;
            liveDemandReviews++;
          }
        } else if (TERMINAL.has(talks.status)) close(track, talks.status, now);
      }
      // A negotiation can disappear without a terminal status when its district changes hands.
      for (const track of tracks.values()) {
        if (track.closed === undefined && !present.has(track.id)) close(track, "removed", now);
      }
      if (evaluation) {
        evaluationPasses++;
        if (liveThisPass) evaluationPassesWithLiveDemand++;
      }
      if (review) reviewPasses++;
    }
  } finally {
    console.info = log;
  }

  const stillLive = [...tracks.values()].filter((track) => track.closed === undefined && LIVE.has(
    world.regionalNegotiations?.get(track.id)?.status ?? ""));
  const lifetimes = closed.map(({ lifetimeDays }) => lifetimeDays);
  const neverEvaluated = closed.filter(({ evaluations }) => evaluations === 0);
  const neverReviewed = closed.filter(({ reviews }) => reviews === 0);
  const backing = closed.filter(({ foreignEver }) => foreignEver);
  const statuses = closed.reduce<Record<string, number>>((counts, { status }) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({
    scenario, seed, days, districts: world.mesoRegions.length, initialNations: world.nations.length,
    finalActive: world.nations.filter(({ macroRegionIds }) => macroRegionIds.length > 0).length,
    demandsOpened: tracks.size, demandsClosed: closed.length, demandsStillLive: stillLive.length,
    statuses,
    lifetimeDays: {
      min: lifetimes.length ? Math.min(...lifetimes) : 0,
      median: median(lifetimes),
      max: lifetimes.length ? Math.max(...lifetimes) : 0,
      mean: lifetimes.length ? lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length : 0,
    },
    closedWithoutAnyEvaluation: neverEvaluated.length,
    closedWithoutEvaluationShare: closed.length ? neverEvaluated.length / closed.length : 0,
    closedWithoutAnyReview: neverReviewed.length,
    closedWithForeignBackingEver: backing.length,
    evaluationPasses, evaluationPassesWithLiveDemand, liveDemandEvaluations,
    reviewPasses, liveDemandReviews,
    foreignAdvocacy: Object.fromEntries(Object.entries(counters).filter(([name]) => name.startsWith("foreignAdvocacy"))),
    regional: Object.fromEntries(Object.entries(counters).filter(([name]) => name.startsWith("regionalNegotiations"))),
    sample: closed.slice(0, 20),
  }));
}
