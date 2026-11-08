import { mkdir, writeFile } from "node:fs/promises";
import {
  setAmphibiousDiagnosticObserver,
  setAmphibiousHybridDiagnosticPolicy,
  setAmphibiousHybridV2DiagnosticPolicy,
  type AmphibiousOperation,
  type BridgeheadCampaign,
} from "../../src/sim/amphibious";
import {
  getCapitalDefenseAssessment,
  type CapitalThreatLevel,
} from "../../src/sim/capital-defense";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const SEED_COUNT = Number(process.env.AMPHIBIOUS_CAPITAL_LAUNCH_STATE_SEED_COUNT ?? 30);
const FAST_TICKS = 3200;
const OUTPUT = "diagnostics/amphibious-capital-launch-state-report.json";
const RECOVERY_WINDOWS = [10, 25, 50, 100, 200] as const;
const VOLATILITY_WINDOWS = [50, 100, 200] as const;
const CANDIDATE_WINDOWS = [25, 50, 100, 200] as const;

type Threat = CapitalThreatLevel | "unknown";
type OutcomeClass = "LANDED" | "STRATEGIC_CAPITAL_ABORT" | "OTHER_ABORT" | "RIGHT_CENSORED";

interface LifecycleSnapshot {
  launchThreat: Threat | null;
  launchRemainingSegments: number | null;
  abortTick: number | null;
  abortReason: string | null;
  abortRemainingSegments: number | null;
  abortThreat: Threat | null;
  landedTick: number | null;
}

interface StateInterval {
  startTick: number;
  endTick: number;
  state: Threat;
}

interface VolatilityFeatures {
  windowTicks: number;
  observedTicks: number;
  transitions: number;
  ticksNone: number;
  ticksThreatened: number;
  ticksCritical: number;
  ticksUnknown: number;
  fractionNone: number | null;
  fractionThreatened: number | null;
  fractionCritical: number | null;
  mostSevereState: Threat;
}

interface LaunchRecord {
  seed: number;
  operationId: string;
  demandId: string;
  campaignId: string | null;
  attackerNationId: string;
  defenderNationId: string;
  operationKind: AmphibiousOperation["kind"];
  launchTick: number;
  capitalStateAtLaunch: Threat;
  previousCapitalState: Threat | null;
  previousCapitalTransitionTick: number | null;
  ticksSincePreviousCapitalTransition: number | null;
  mostRecentCriticalTickBeforeLaunch: number | null;
  ticksSinceCritical: number | null;
  criticalEpisodeEndTick: number | null;
  ticksSinceCriticalEnded: number | null;
  durationOfPreviousCriticalEpisode: number | null;
  numberOfCriticalEpisodesInPrevious200Ticks: number;
  numberOfThreatTransitionsInPrevious200Ticks: number;
  ticksSinceThreatenedStarted: number | null;
  directPreviousStateBeforeThreatened: Threat | null;
  capitalHistoryCategoryByWindow: Record<string, string>;
  volatility: Record<string, VolatilityFeatures>;
  preLaunchCapitalTransitions: Array<{ tick: number; previousState: Threat; state: Threat }>;
  voyageCapitalTransitions: Array<{ tick: number; previousState: Threat; state: Threat }>;
  landed: boolean;
  landingTick: number | null;
  launchToLandingTicks: number | null;
  beachheadEstablished: boolean;
  beachheadOutcome: AmphibiousOperation["beachheadOutcome"];
  campaignCompleted: boolean | null;
  campaignStatus: BridgeheadCampaign["status"] | null;
  cancelled: boolean;
  cancellationReason: string | null;
  strategicCapitalCriticalAbort: boolean;
  warEndedAbort: boolean;
  targetInvalidAbort: boolean;
  otherAbort: boolean;
  rightCensored: boolean;
  outcomeClass: OutcomeClass;
  launchToAbortTicks: number | null;
  voyageProgressAtAbort: number | null;
  routeSegmentsAtLaunch: number;
  remainingSegmentsAtAbort: number | null;
  estimatedVoyageTicks: number;
  observedVoyageTicks: number;
  voyageTicksNone: number;
  voyageTicksThreatened: number;
  voyageTicksCritical: number;
  voyageTicksUnknown: number;
  finalCapitalStateDuringVoyage: Threat;
}

interface RunResult {
  seed: number;
  launches: LaunchRecord[];
  capitalStateIntervals: Array<{ nationId: string; intervals: StateInterval[] }>;
}

const originalConsoleInfo = console.info;
console.info = () => undefined;
const runs: RunResult[] = [];
try {
  setAmphibiousHybridDiagnosticPolicy(true);
  setAmphibiousHybridV2DiagnosticPolicy(true);
  for (let index = 0; index < SEED_COUNT; index += 1) {
    runs.push(runSeed(FIRST_SEED + index));
  }
} finally {
  console.info = originalConsoleInfo;
  setAmphibiousHybridDiagnosticPolicy(false);
  setAmphibiousHybridV2DiagnosticPolicy(false);
  setAmphibiousDiagnosticObserver(null);
}

const launches = runs.flatMap((run) => run.launches);
const report = {
  experiment: {
    scenario: "active-war",
    seeds: { first: FIRST_SEED, last: FIRST_SEED + SEED_COUNT - 1, count: SEED_COUNT },
    resolution: { width: 1920, height: 1080 },
    speed: 32,
    fastTicks: FAST_TICKS,
    policy: "Hybrid V2: launch-feasibility gate plus voyage abort on attacker capital critical plus pre-launch hold while critical",
    retargeting: false,
  },
  metricSemantics: {
    primaryUnit: "Unique actual launch, keyed by seed plus stable operationId.",
    capitalStateSampling: "The cached canonical capital-defense assessment visible to amphibious launch decisions at each fast tick. State is sampled immediately before that tick's fast update; compact intervals are decision-time intervals, not inferred combat state.",
    previousWindowConvention: "Lookback windows contain ticks [launchTick - N, launchTick - 1]. The launch tick is reported separately.",
    recentCritical: "At least one canonical CRITICAL tick in the stated pre-launch lookback window.",
    criticalRecovery: "A THREATENED launch whose current threatened interval directly followed a CRITICAL interval. Recovery age is launchTick minus the first threatened decision tick.",
    stableLabels: "STABLE means no capital-state transition in the stated diagnostic window. Windows are analysis labels only, not gameplay constants.",
    beachheadEstablished: "True only for an original landing operation whose final beachheadOutcome is success; reinforcement arrivals are not counted as newly established beachheads.",
    campaignCompleted: "Final observed status of the campaign linked by originOperationId or bridgeheadCampaignId; null when no campaign was established/linked.",
    rightCensored: `Launched operation still active at the ${FAST_TICKS}-tick horizon; it is not counted as a failure.`,
    candidateRules: "Decision-level observational filters over realized launches. Counts are not counterfactual world outcomes because vetoing a launch could change later world state and future operations.",
  },
  summary: summarize(launches),
  launchStateComparison: launchStateComparison(launches),
  criticalRecoveryAnalysis: criticalRecoveryAnalysis(launches),
  volatilityAnalysis: volatilityAnalysis(launches),
  successfulThreatenedLaunches: launches.filter((launch) => launch.capitalStateAtLaunch === "threatened" && launch.landed).map(compactCase),
  failedThreatenedLaunches: launches.filter((launch) => launch.capitalStateAtLaunch === "threatened" && launch.cancelled).map(compactCase),
  offlineCandidateRules: candidateRules(launches),
  representativeCases: representativeCases(launches),
  capitalStateIntervals: runs.map((run) => ({ seed: run.seed, nations: run.capitalStateIntervals })),
  launches,
};

await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Amphibious capital launch-state diagnostic complete: ${OUTPUT}`);

function runSeed(seed: number): RunResult {
  const world = createScenarioWorld("active-war", {
    seed,
    width: 1920,
    height: 1080,
    quick: false,
    reserveEnabled: true,
    reorganizationEnabled: true,
    exploitationEnabled: true,
    pocketReductionEnabled: true,
  });
  const histories = new Map<NationId, Threat[]>();
  const lifecycle = new Map<string, LifecycleSnapshot>();

  setAmphibiousDiagnosticObserver({
    onOperationLifecycle(event) {
      let snapshot = lifecycle.get(event.operationId);
      if (!snapshot) {
        snapshot = {
          launchThreat: null,
          launchRemainingSegments: null,
          abortTick: null,
          abortReason: null,
          abortRemainingSegments: null,
          abortThreat: null,
          landedTick: null,
        };
        lifecycle.set(event.operationId, snapshot);
      }
      if (event.decision === "launch") {
        snapshot.launchThreat = normalizeThreat(event.ownCapitalThreat);
        snapshot.launchRemainingSegments = event.remainingRouteSegments;
      } else if (event.decision === "abort") {
        snapshot.abortTick = event.tick;
        snapshot.abortReason = event.reason;
        snapshot.abortRemainingSegments = event.remainingRouteSegments;
        snapshot.abortThreat = normalizeThreat(event.ownCapitalThreat);
      } else if (event.decision === "landed") {
        snapshot.landedTick = event.tick;
      }
    },
  });

  for (let index = 0; index < FAST_TICKS; index += 1) {
    const decisionTick = world.time.fastTick + 1;
    sampleDecisionState(world, histories, decisionTick);
    stepFastTick(world, FAST_TICK_MS);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) stepSlowTick(world, SLOW_TICK_MS);
  }

  const launches = world.amphibiousOperations.operations
    .filter((operation) => operation.launchedAtTick !== null)
    .map((operation) => buildLaunch(seed, world, operation, histories.get(operation.nationId) ?? [], lifecycle.get(operation.id)));
  const launchedNationIds = new Set(launches.map((launch) => launch.attackerNationId));
  const capitalStateIntervals = [...histories.entries()]
    .filter(([nationId]) => launchedNationIds.has(nationId))
    .map(([nationId, history]) => ({ nationId, intervals: intervals(history, 1, FAST_TICKS) }));
  return { seed, launches, capitalStateIntervals };
}

function sampleDecisionState(world: WorldState, histories: Map<NationId, Threat[]>, tick: number): void {
  for (const nation of world.nations) {
    const history = histories.get(nation.id) ?? [];
    history[tick] = normalizeThreat(getCapitalDefenseAssessment(world, nation.id)?.threatLevel ?? null);
    histories.set(nation.id, history);
  }
}

function buildLaunch(
  seed: number,
  world: WorldState,
  operation: AmphibiousOperation,
  history: Threat[],
  lifecycle: LifecycleSnapshot | undefined,
): LaunchRecord {
  const launchTick = operation.launchedAtTick!;
  const stateAtLaunch = lifecycle?.launchThreat ?? history[launchTick] ?? "unknown";
  const transitions = stateTransitions(history, 1, FAST_TICKS);
  // A transition effective on the launch tick is already visible to the launch
  // decision, so it is the launch state's immediately preceding state.
  const priorTransitions = transitions.filter((transition) => transition.tick <= launchTick);
  const lastTransition = priorTransitions.at(-1) ?? null;
  const currentStateStartTick = lastTransition?.tick ?? firstObservedTick(history, stateAtLaunch, launchTick);
  const directPreviousState = lastTransition?.previousState ?? null;
  const previousCriticalEpisode = findPreviousEpisode(history, launchTick, "critical");
  const mostRecentCriticalTick = findLastTick(history, launchTick - 1, "critical");
  const criticalEpisodeEndTick = previousCriticalEpisode?.endTick !== null && previousCriticalEpisode?.endTick !== undefined
    ? previousCriticalEpisode.endTick + 1
    : null;
  const currentThreatenedDirectlyFollowedCritical = stateAtLaunch === "threatened" && directPreviousState === "critical";
  const voyageEndTick = operation.completedAtTick ?? FAST_TICKS;
  const voyage = countStates(history, launchTick, voyageEndTick);
  const campaign = campaignForOperation(world, operation);
  const landed = operation.phase === "landed";
  const cancelled = operation.phase === "cancelled";
  const strategicAbort = operation.cancellationReason === "strategic-capital-critical";
  const rightCensored = !landed && !cancelled;
  const routeSegments = Math.max(0, operation.routeRegionIds.length - 1);
  const remainingAtAbort = lifecycle?.abortRemainingSegments ?? null;
  const outcomeClass: OutcomeClass = landed
    ? "LANDED"
    : strategicAbort
      ? "STRATEGIC_CAPITAL_ABORT"
      : cancelled
        ? "OTHER_ABORT"
        : "RIGHT_CENSORED";
  const categoryByWindow = Object.fromEntries(RECOVERY_WINDOWS.map((window) => [
    String(window),
    historyCategory(history, launchTick, stateAtLaunch, window, currentThreatenedDirectlyFollowedCritical),
  ]));

  return {
    seed,
    operationId: operation.id,
    demandId: operation.capabilityDemandId,
    campaignId: campaign?.id ?? operation.bridgeheadCampaignId,
    attackerNationId: operation.nationId,
    defenderNationId: operation.enemyNationId,
    operationKind: operation.kind,
    launchTick,
    capitalStateAtLaunch: stateAtLaunch,
    previousCapitalState: directPreviousState,
    previousCapitalTransitionTick: lastTransition?.tick ?? null,
    ticksSincePreviousCapitalTransition: currentStateStartTick === null ? null : launchTick - currentStateStartTick,
    mostRecentCriticalTickBeforeLaunch: mostRecentCriticalTick,
    ticksSinceCritical: mostRecentCriticalTick === null ? null : launchTick - mostRecentCriticalTick,
    criticalEpisodeEndTick,
    ticksSinceCriticalEnded: criticalEpisodeEndTick === null ? null : launchTick - criticalEpisodeEndTick,
    durationOfPreviousCriticalEpisode: previousCriticalEpisode === null
      ? null
      : previousCriticalEpisode.endTick - previousCriticalEpisode.startTick + 1,
    numberOfCriticalEpisodesInPrevious200Ticks: countEpisodes(history, launchTick - 200, launchTick - 1, "critical"),
    numberOfThreatTransitionsInPrevious200Ticks: transitions.filter((transition) =>
      transition.tick >= launchTick - 200 && transition.tick < launchTick &&
      (transition.previousState !== "none" || transition.state !== "none")).length,
    ticksSinceThreatenedStarted: stateAtLaunch === "threatened" && currentStateStartTick !== null
      ? launchTick - currentStateStartTick
      : null,
    directPreviousStateBeforeThreatened: stateAtLaunch === "threatened" ? directPreviousState : null,
    capitalHistoryCategoryByWindow: categoryByWindow,
    volatility: Object.fromEntries(VOLATILITY_WINDOWS.map((window) => [String(window), volatility(history, launchTick, window)])),
    preLaunchCapitalTransitions: transitions.filter((transition) => transition.tick >= launchTick - 200 && transition.tick <= launchTick),
    voyageCapitalTransitions: transitions.filter((transition) => transition.tick > launchTick && transition.tick <= voyageEndTick),
    landed,
    landingTick: landed ? operation.completedAtTick : null,
    launchToLandingTicks: landed && operation.completedAtTick !== null ? operation.completedAtTick - launchTick : null,
    beachheadEstablished: operation.kind === "landing" && operation.beachheadOutcome === "success",
    beachheadOutcome: operation.beachheadOutcome,
    campaignCompleted: campaign ? campaign.status === "completed" : null,
    campaignStatus: campaign?.status ?? null,
    cancelled,
    cancellationReason: operation.cancellationReason,
    strategicCapitalCriticalAbort: strategicAbort,
    warEndedAbort: operation.cancellationReason === "war-ended",
    targetInvalidAbort: operation.cancellationReason === "target-invalid",
    otherAbort: cancelled && !strategicAbort && operation.cancellationReason !== "war-ended" && operation.cancellationReason !== "target-invalid",
    rightCensored,
    outcomeClass,
    launchToAbortTicks: cancelled && operation.completedAtTick !== null ? operation.completedAtTick - launchTick : null,
    voyageProgressAtAbort: cancelled && remainingAtAbort !== null && routeSegments > 0
      ? 1 - remainingAtAbort / routeSegments
      : null,
    routeSegmentsAtLaunch: lifecycle?.launchRemainingSegments ?? routeSegments,
    remainingSegmentsAtAbort: remainingAtAbort,
    estimatedVoyageTicks: operation.launchFeasibility.estimatedVoyageTicks,
    observedVoyageTicks: voyage.observed,
    voyageTicksNone: voyage.none,
    voyageTicksThreatened: voyage.threatened,
    voyageTicksCritical: voyage.critical,
    voyageTicksUnknown: voyage.unknown,
    finalCapitalStateDuringVoyage: history[voyageEndTick] ?? "unknown",
  };
}

function summarize(all: LaunchRecord[]) {
  return {
    totalLaunches: all.length,
    uniqueLaunchKeys: new Set(all.map((launch) => `${launch.seed}:${launch.operationId}`)).size,
    byLaunchCapitalState: Object.fromEntries(["none", "threatened", "critical", "unknown"].map((state) => [state, aggregate(all.filter((launch) => launch.capitalStateAtLaunch === state))])),
    strategicCapitalAborts: all.filter((launch) => launch.strategicCapitalCriticalAbort).length,
    allAborts: all.filter((launch) => launch.cancelled).length,
    landed: all.filter((launch) => launch.landed).length,
    beachheads: all.filter((launch) => launch.beachheadEstablished).length,
    campaignsCompleted: all.filter((launch) => launch.campaignCompleted).length,
    rightCensored: all.filter((launch) => launch.rightCensored).length,
    criticalLaunches: all.filter((launch) => launch.capitalStateAtLaunch === "critical").length,
  };
}

function launchStateComparison(all: LaunchRecord[]) {
  const none = all.filter((launch) => launch.capitalStateAtLaunch === "none");
  const threatened = all.filter((launch) => launch.capitalStateAtLaunch === "threatened");
  return {
    table: Object.fromEntries(["none", "threatened", "critical"].map((state) => [state.toUpperCase(), aggregate(all.filter((launch) => launch.capitalStateAtLaunch === state))])),
    noneVsThreatened: {
      landing: compareRates(none.filter((launch) => launch.landed).length, none.length, threatened.filter((launch) => launch.landed).length, threatened.length),
      strategicCapitalAbort: compareRates(none.filter((launch) => launch.strategicCapitalCriticalAbort).length, none.length, threatened.filter((launch) => launch.strategicCapitalCriticalAbort).length, threatened.length),
      allAbort: compareRates(none.filter((launch) => launch.cancelled).length, none.length, threatened.filter((launch) => launch.cancelled).length, threatened.length),
    },
  };
}

function criticalRecoveryAnalysis(all: LaunchRecord[]) {
  const threatened = all.filter((launch) => launch.capitalStateAtLaunch === "threatened");
  return Object.fromEntries(RECOVERY_WINDOWS.map((window) => {
    const recent = threatened.filter((launch) => hadCriticalInWindow(launch, window));
    const noRecent = threatened.filter((launch) => !hadCriticalInWindow(launch, window));
    const directRecovery = recent.filter((launch) => launch.directPreviousStateBeforeThreatened === "critical");
    return [String(window), {
      windowTicks: window,
      criticalEndedOrObservedWithinWindow: aggregate(recent),
      directCriticalToThreatenedRecoveryWithinWindow: aggregate(directRecovery),
      noCriticalInLookbackWindow: aggregate(noRecent),
      stableThreatenedForEntireWindow: aggregate(threatened.filter((launch) =>
        launch.capitalHistoryCategoryByWindow[String(window)] === "STABLE_THREATENED")),
      recentNoneToThreatenedWithinWindow: aggregate(threatened.filter((launch) =>
        launch.capitalHistoryCategoryByWindow[String(window)] === "RECENT_NONE_TO_THREATENED")),
      otherOrInsufficientHistory: aggregate(threatened.filter((launch) =>
        launch.capitalHistoryCategoryByWindow[String(window)] === "OTHER_OR_INSUFFICIENT_HISTORY")),
      recentVsNoRecent: {
        landing: compareRates(recent.filter((launch) => launch.landed).length, recent.length, noRecent.filter((launch) => launch.landed).length, noRecent.length),
        strategicCapitalAbort: compareRates(recent.filter((launch) => launch.strategicCapitalCriticalAbort).length, recent.length, noRecent.filter((launch) => launch.strategicCapitalCriticalAbort).length, noRecent.length),
      },
    }];
  }));
}

function volatilityAnalysis(all: LaunchRecord[]) {
  return Object.fromEntries(VOLATILITY_WINDOWS.map((window) => [String(window), {
    windowTicks: window,
    landed: averageVolatility(all.filter((launch) => launch.landed), window),
    strategicCapitalAbort: averageVolatility(all.filter((launch) => launch.strategicCapitalCriticalAbort), window),
    otherAbort: averageVolatility(all.filter((launch) => launch.cancelled && !launch.strategicCapitalCriticalAbort), window),
    rightCensored: averageVolatility(all.filter((launch) => launch.rightCensored), window),
    threatenedLanded: averageVolatility(all.filter((launch) => launch.capitalStateAtLaunch === "threatened" && launch.landed), window),
    threatenedCapitalAbort: averageVolatility(all.filter((launch) => launch.capitalStateAtLaunch === "threatened" && launch.strategicCapitalCriticalAbort), window),
  }]));
}

function candidateRules(all: LaunchRecord[]) {
  const candidates: Array<{ name: string; predicate: (launch: LaunchRecord) => boolean }> = [
    { name: "A_BLOCK_ALL_THREATENED", predicate: (launch) => launch.capitalStateAtLaunch === "threatened" },
    ...CANDIDATE_WINDOWS.map((window) => ({
      name: `B_TO_E_BLOCK_THREATENED_IF_CRITICAL_WITHIN_${window}`,
      predicate: (launch: LaunchRecord) => launch.capitalStateAtLaunch === "threatened" && hadCriticalInWindow(launch, window),
    })),
    ...CANDIDATE_WINDOWS.map((window) => ({
      name: `F_REQUIRE_CONTINUOUSLY_NON_CRITICAL_FOR_${window}`,
      predicate: (launch: LaunchRecord) => hadCriticalInWindow(launch, window),
    })),
  ];
  const baseLandings = all.filter((launch) => launch.landed).length;
  const baseBeachheads = all.filter((launch) => launch.beachheadEstablished).length;
  const baseCapitalAborts = all.filter((launch) => launch.strategicCapitalCriticalAbort).length;
  return candidates.map((candidate) => {
    const vetoed = all.filter(candidate.predicate);
    return {
      candidate: candidate.name,
      launchesVetoed: vetoed.length,
      successfulLandingsVetoed: vetoed.filter((launch) => launch.landed).length,
      beachheadsVetoed: vetoed.filter((launch) => launch.beachheadEstablished).length,
      campaignsCompletedVetoed: vetoed.filter((launch) => launch.campaignCompleted).length,
      strategicCapitalAbortsPrevented: vetoed.filter((launch) => launch.strategicCapitalCriticalAbort).length,
      otherFailedLaunchesVetoed: vetoed.filter((launch) => launch.cancelled && !launch.strategicCapitalCriticalAbort).length,
      rightCensoredLaunchesVetoed: vetoed.filter((launch) => launch.rightCensored).length,
      launchesRetained: all.length - vetoed.length,
      landingRetention: ratio(baseLandings - vetoed.filter((launch) => launch.landed).length, baseLandings),
      beachheadRetention: ratio(baseBeachheads - vetoed.filter((launch) => launch.beachheadEstablished).length, baseBeachheads),
      capitalAbortPrevention: ratio(vetoed.filter((launch) => launch.strategicCapitalCriticalAbort).length, baseCapitalAborts),
      vetoedLaunchKeys: vetoed.map((launch) => `${launch.seed}:${launch.operationId}`),
    };
  });
}

function aggregate(items: LaunchRecord[]) {
  const launches = items.length;
  const landed = items.filter((launch) => launch.landed).length;
  const beachheads = items.filter((launch) => launch.beachheadEstablished).length;
  const campaignsCompleted = items.filter((launch) => launch.campaignCompleted).length;
  const strategicCapitalAborts = items.filter((launch) => launch.strategicCapitalCriticalAbort).length;
  const allAborts = items.filter((launch) => launch.cancelled).length;
  return {
    launches,
    landed,
    landingRate: ratio(landed, launches),
    landingRateWilson95: wilson(landed, launches),
    beachheads,
    beachheadPerLaunch: ratio(beachheads, launches),
    campaignsCompleted,
    strategicCapitalAborts,
    capitalAbortRate: ratio(strategicCapitalAborts, launches),
    capitalAbortRateWilson95: wilson(strategicCapitalAborts, launches),
    allAborts,
    allAbortRate: ratio(allAborts, launches),
    rightCensored: items.filter((launch) => launch.rightCensored).length,
  };
}

function compareRates(firstEvents: number, firstTotal: number, secondEvents: number, secondTotal: number) {
  const firstRate = ratio(firstEvents, firstTotal);
  const secondRate = ratio(secondEvents, secondTotal);
  return {
    noneOrRecent: { events: firstEvents, total: firstTotal, rate: firstRate, wilson95: wilson(firstEvents, firstTotal) },
    threatenedOrNoRecent: { events: secondEvents, total: secondTotal, rate: secondRate, wilson95: wilson(secondEvents, secondTotal) },
    secondMinusFirstRiskDifference: firstRate === null || secondRate === null ? null : secondRate - firstRate,
    secondToFirstRiskRatio: firstRate === null || secondRate === null || firstRate === 0 ? null : secondRate / firstRate,
  };
}

function compactCase(launch: LaunchRecord) {
  return {
    seed: launch.seed,
    operationId: launch.operationId,
    demandId: launch.demandId,
    campaignId: launch.campaignId,
    launchTick: launch.launchTick,
    outcomeClass: launch.outcomeClass,
    landed: launch.landed,
    beachheadEstablished: launch.beachheadEstablished,
    campaignCompleted: launch.campaignCompleted,
    cancellationReason: launch.cancellationReason,
    launchToLandingTicks: launch.launchToLandingTicks,
    launchToAbortTicks: launch.launchToAbortTicks,
    ticksSinceCritical: launch.ticksSinceCritical,
    ticksSinceCriticalEnded: launch.ticksSinceCriticalEnded,
    directPreviousStateBeforeThreatened: launch.directPreviousStateBeforeThreatened,
    numberOfCriticalEpisodesInPrevious200Ticks: launch.numberOfCriticalEpisodesInPrevious200Ticks,
    numberOfThreatTransitionsInPrevious200Ticks: launch.numberOfThreatTransitionsInPrevious200Ticks,
    routeSegmentsAtLaunch: launch.routeSegmentsAtLaunch,
    estimatedVoyageTicks: launch.estimatedVoyageTicks,
    voyageCapitalTicks: {
      none: launch.voyageTicksNone,
      threatened: launch.voyageTicksThreatened,
      critical: launch.voyageTicksCritical,
      unknown: launch.voyageTicksUnknown,
    },
    finalCapitalStateDuringVoyage: launch.finalCapitalStateDuringVoyage,
    preLaunchCapitalTransitions: launch.preLaunchCapitalTransitions,
    voyageCapitalTransitions: launch.voyageCapitalTransitions,
  };
}

function representativeCases(all: LaunchRecord[]) {
  const threatenedSuccesses = all.filter((launch) => launch.capitalStateAtLaunch === "threatened" && launch.landed);
  const threatenedCapitalAborts = all.filter((launch) => launch.capitalStateAtLaunch === "threatened" && launch.strategicCapitalCriticalAbort);
  const recentRecoveryAbort = [...threatenedCapitalAborts]
    .filter((launch) => launch.directPreviousStateBeforeThreatened === "critical")
    .sort((a, b) => (a.ticksSinceCriticalEnded ?? Infinity) - (b.ticksSinceCriticalEnded ?? Infinity))[0];
  const stableThreatenedSuccess = [...threatenedSuccesses]
    .sort((a, b) => (b.ticksSincePreviousCapitalTransition ?? -1) - (a.ticksSincePreviousCapitalTransition ?? -1))[0];
  return {
    mostRecentCriticalRecoveryAbort: recentRecoveryAbort ? compactCase(recentRecoveryAbort) : null,
    mostStableThreatenedLanding: stableThreatenedSuccess ? compactCase(stableThreatenedSuccess) : null,
    threatenedLandingWithMostTransitions: threatenedSuccesses.sort((a, b) => b.numberOfThreatTransitionsInPrevious200Ticks - a.numberOfThreatTransitionsInPrevious200Ticks)[0]
      ? compactCase(threatenedSuccesses[0])
      : null,
  };
}

function historyCategory(history: Threat[], launchTick: number, stateAtLaunch: Threat, window: number, directCriticalRecovery: boolean): string {
  const windowTransitions = stateTransitions(history, Math.max(1, launchTick - window), launchTick - 1);
  const hasCritical = rangeContains(history, launchTick - window, launchTick - 1, "critical");
  if (stateAtLaunch === "none" && windowTransitions.length === 0) return "STABLE_NONE";
  if (stateAtLaunch === "threatened" && directCriticalRecovery && hasCritical) return "RECENT_CRITICAL_TO_THREATENED";
  if (stateAtLaunch === "threatened" && directStateBeforeCurrentInterval(history, launchTick) === "none" && windowTransitions.length > 0) return "RECENT_NONE_TO_THREATENED";
  if (stateAtLaunch === "threatened" && windowTransitions.length === 0 && !hasCritical) return "STABLE_THREATENED";
  return "OTHER_OR_INSUFFICIENT_HISTORY";
}

function volatility(history: Threat[], launchTick: number, window: number): VolatilityFeatures {
  const start = Math.max(1, launchTick - window);
  const end = launchTick - 1;
  const counts = countStates(history, start, end);
  const observed = counts.none + counts.threatened + counts.critical;
  return {
    windowTicks: window,
    observedTicks: counts.observed,
    transitions: stateTransitions(history, start, end).length,
    ticksNone: counts.none,
    ticksThreatened: counts.threatened,
    ticksCritical: counts.critical,
    ticksUnknown: counts.unknown,
    fractionNone: ratio(counts.none, observed),
    fractionThreatened: ratio(counts.threatened, observed),
    fractionCritical: ratio(counts.critical, observed),
    mostSevereState: counts.critical > 0 ? "critical" : counts.threatened > 0 ? "threatened" : counts.none > 0 ? "none" : "unknown",
  };
}

function averageVolatility(items: LaunchRecord[], window: number) {
  const features = items.map((launch) => launch.volatility[String(window)]);
  return {
    launches: items.length,
    meanTransitions: mean(features.map((feature) => feature.transitions)),
    meanTicksNone: mean(features.map((feature) => feature.ticksNone)),
    meanTicksThreatened: mean(features.map((feature) => feature.ticksThreatened)),
    meanTicksCritical: mean(features.map((feature) => feature.ticksCritical)),
    launchesWithAnyCritical: features.filter((feature) => feature.ticksCritical > 0).length,
    launchesWithAtLeastTwoTransitions: features.filter((feature) => feature.transitions >= 2).length,
  };
}

function hadCriticalInWindow(launch: LaunchRecord, window: number): boolean {
  return launch.ticksSinceCritical !== null && launch.ticksSinceCritical <= window;
}

function stateTransitions(history: Threat[], startTick: number, endTick: number) {
  const output: Array<{ tick: number; previousState: Threat; state: Threat }> = [];
  const start = Math.max(1, startTick);
  let previous = start > 1 ? history[start - 1] ?? "unknown" : history[start] ?? "unknown";
  for (let tick = start > 1 ? start : start + 1; tick <= endTick; tick += 1) {
    const state = history[tick] ?? "unknown";
    if (state !== previous) output.push({ tick, previousState: previous, state });
    previous = state;
  }
  return output;
}

function intervals(history: Threat[], startTick: number, endTick: number): StateInterval[] {
  if (endTick < startTick) return [];
  const output: StateInterval[] = [];
  let start = startTick;
  let state = history[startTick] ?? "unknown";
  for (let tick = startTick + 1; tick <= endTick; tick += 1) {
    const next = history[tick] ?? "unknown";
    if (next === state) continue;
    output.push({ startTick: start, endTick: tick - 1, state });
    start = tick;
    state = next;
  }
  output.push({ startTick: start, endTick, state });
  return output;
}

function countStates(history: Threat[], startTick: number, endTick: number) {
  const counts = { observed: 0, none: 0, threatened: 0, critical: 0, unknown: 0 };
  for (let tick = Math.max(1, startTick); tick <= Math.min(FAST_TICKS, endTick); tick += 1) {
    const state = history[tick] ?? "unknown";
    counts.observed += 1;
    counts[state] += 1;
  }
  return counts;
}

function countEpisodes(history: Threat[], startTick: number, endTick: number, target: Threat): number {
  let episodes = 0;
  let inside = false;
  for (let tick = Math.max(1, startTick); tick <= endTick; tick += 1) {
    const matches = history[tick] === target;
    if (matches && !inside) episodes += 1;
    inside = matches;
  }
  return episodes;
}

function findPreviousEpisode(history: Threat[], launchTick: number, target: Threat): { startTick: number; endTick: number } | null {
  const endTick = findLastTick(history, launchTick - 1, target);
  if (endTick === null) return null;
  let startTick = endTick;
  while (startTick > 1 && history[startTick - 1] === target) startTick -= 1;
  return { startTick, endTick };
}

function findLastTick(history: Threat[], beforeOrAt: number, target: Threat): number | null {
  for (let tick = beforeOrAt; tick >= 1; tick -= 1) if (history[tick] === target) return tick;
  return null;
}

function firstObservedTick(history: Threat[], state: Threat, beforeOrAt: number): number | null {
  let tick = beforeOrAt;
  if ((history[tick] ?? "unknown") !== state) return null;
  while (tick > 1 && (history[tick - 1] ?? "unknown") === state) tick -= 1;
  return tick;
}

function directStateBeforeCurrentInterval(history: Threat[], tick: number): Threat | null {
  const current = history[tick] ?? "unknown";
  for (let cursor = tick - 1; cursor >= 1; cursor -= 1) {
    const state = history[cursor] ?? "unknown";
    if (state !== current) return state;
  }
  return null;
}

function rangeContains(history: Threat[], startTick: number, endTick: number, target: Threat): boolean {
  for (let tick = Math.max(1, startTick); tick <= endTick; tick += 1) if (history[tick] === target) return true;
  return false;
}

function campaignForOperation(world: WorldState, operation: AmphibiousOperation): BridgeheadCampaign | undefined {
  return world.amphibiousOperations.bridgeheadCampaigns.find((campaign) =>
    campaign.originOperationId === operation.id || campaign.id === operation.bridgeheadCampaignId);
}

function normalizeThreat(value: string | null): Threat {
  return value === "none" || value === "threatened" || value === "critical" ? value : "unknown";
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function wilson(events: number, total: number): { low: number; high: number } | null {
  if (total === 0) return null;
  const z = 1.959963984540054;
  const rate = events / total;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}
