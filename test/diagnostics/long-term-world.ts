import assert from "node:assert/strict";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import type { SimulationCounterName, SimulationMetricName } from "../../src/sim/instrumentation";
import { DAYS_PER_SLOW_TICK } from "../../src/sim/time";
import { isNationActive } from "../../src/sim/nation-active";
import { installSubjectGovernment } from "../../src/sim/subject-governments";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { stepSimulationDay } from "../../src/sim/update";
import { createSeededWorld } from "../helpers/seeded-world";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { observeWorldHistory } from "./world-history-observer";
import { createFlowTotals, sampleFlows, summarizeWorld } from "./world-checkpoint";
import { seedSubjectAcquisitions } from "./seed-subject-acquisitions";
import { setForeignAdvocacySchedule } from "../../src/sim/foreign-advocacy-schedule";
import { observeAdvocacyScheduling } from "./observe-advocacy-scheduling";
import { observeAdvocacyReassessment } from "./observe-advocacy-reassessment";
import { observeFoodAndTreasury } from "./observe-food-and-treasury";
import { observeFuelAccounting } from "./observe-fuel-accounting";
import { worldSignature } from "./world-signature";

const [scenario, rawSeed, ...rawDays] = process.argv.slice(2);
assert(["quick", "quick-default", "medium", "scale", "dense"].includes(scenario ?? ""),
  "Usage: long-term-world.ts quick|quick-default|medium|scale|dense SEED DAY [DAY...]");
const seed = Number(rawSeed), days = rawDays.map(Number);
assert(Number.isSafeInteger(seed) && seed >= 0);
assert(days.length && days.every((day, index) => Number.isSafeInteger(day) && day > (days[index - 1] ?? 0)));
const optionalSystems = ["warCampaignEnabled", "politicalTurbulenceEnabled", "defeatedFormationsEnabled", "economicPlanningEnabled"] as const;
const disabled = process.env.WORLD_DISABLE;
assert(!disabled || optionalSystems.some((system) => system === disabled), "Unknown WORLD_DISABLE setting");
const settings = createSimulationSettings(scenario === "quick-default" ? {} : {
  warCampaignEnabled: disabled !== "warCampaignEnabled",
  politicalTurbulenceEnabled: disabled !== "politicalTurbulenceEnabled",
  defeatedFormationsEnabled: disabled !== "defeatedFormationsEnabled",
  ...(disabled === "economicPlanningEnabled" ? { economicPlanningEnabled: false } : {}),
});
const world = withMutedSimulationLogs(() => createSeededWorld({
  seed, quick: scenario.startsWith("quick"), config: {
    systems: settings,
    ...(scenario === "scale" || scenario === "dense" ? {
      nationTargetMacroRegionsPerNation: 1,
      nationMacroRegionSizeRange: scenario === "dense" ? { min: 2, max: 4 } : { min: 7, max: 11 },
    } : {}),
  },
}));
const advocacySchedule = process.env.WORLD_ADVOCACY_SCHEDULE;
assert(advocacySchedule === undefined || advocacySchedule === "periodic" ||
  advocacySchedule === "event" || advocacySchedule === "100-day", "Unknown advocacy schedule");
if (advocacySchedule) setForeignAdvocacySchedule(world, advocacySchedule);
const strategy = process.env.WORLD_ADVOCACY_REASSESSMENT || undefined;
assert(strategy === undefined || strategy === "initial" || strategy === "threshold" || strategy === "fallback", "Unknown reassessment strategy");
assert(!strategy || !advocacySchedule || advocacySchedule === "event", "Reassessment requires event screening");
const advocacy = advocacySchedule || strategy ? observeAdvocacyScheduling(world) : undefined;
const reassessment = strategy ? observeAdvocacyReassessment(world, strategy) : undefined;
// Optional scale fixture gives negotiations work even when the generated world remains at peace.
const subjectPairs = Number(process.env.WORLD_SUBJECT_PAIRS ?? 0);
assert(Number.isSafeInteger(subjectPairs) && subjectPairs >= 0);
const selectedOverlord = process.env.WORLD_SUBJECT_OVERLORD;
assert(!selectedOverlord || subjectPairs === 1, "WORLD_SUBJECT_OVERLORD requires one starting subject");
if (subjectPairs) withMutedSimulationLogs(() => {
  const paired = new Set<string>();
  for (const [a, b] of getAdjacentNationPairs(world)) {
    if (selectedOverlord && a !== selectedOverlord && b !== selectedOverlord) continue;
    const [overlord, subject] = selectedOverlord === b ? [b, a] : [a, b];
    if (paired.has(overlord) || paired.has(subject)) continue;
    installSubjectGovernment(world, overlord, subject);
    const nation = world.nations.find(({ id }) => id === subject)!;
    const autonomyBase = Number(process.env.WORLD_SUBJECT_AUTONOMY ?? 44);
    nation.subjectGovernment!.autonomy = Math.max(0, Math.min(100, autonomyBase + (paired.size % 6) * 5));
    paired.add(overlord);
    paired.add(subject);
    if (paired.size === 2 * subjectPairs) break;
  }
  assert.equal(paired.size, 2 * subjectPairs, "Not enough disjoint neighboring governments");
});
const requestedAcquisitions = Number(process.env.WORLD_SUBJECT_ACQUISITIONS ?? 0);
assert(Number.isSafeInteger(requestedAcquisitions) && requestedAcquisitions >= 0);
const seededAcquisitions = requestedAcquisitions ? seedSubjectAcquisitions(world, requestedAcquisitions) : 0;
if (requestedAcquisitions) assert(seededAcquisitions > 0, "No eligible borders for the controlled acquisitions");
const fuelAccounting = process.env.WORLD_FUEL_ACCOUNTING === "1" ? observeFuelAccounting(world) : undefined;
const procurement = process.env.WORLD_PROCUREMENT_FUNNEL === "1"
  ? new Map<string, { buyerId: string; resource: string; considered: number; noCandidate: number;
      noRoute: number; rejected: number; dispatched: number; delivered: number; returned: number;
      quantities: { dispatched: number; delivered: number; returned: number } }>()
  : undefined;
assert(!fuelAccounting || !disabled, "Fuel accounting requires the standard economic systems");
const timings: Partial<Record<SimulationMetricName, number>> = {};
const counters: Partial<Record<SimulationCounterName, number>> = {};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const fiscalAccounting = fuelAccounting ? observeFoodAndTreasury(world, counters) : undefined;
const redistributionSamples: import("../../src/sim/instrumentation").RedistributionReviewSample[] = [];
if (process.env.WORLD_METRICS === "1" || advocacy || fuelAccounting || procurement) world.instrumentation = {
  ...advocacy?.instrumentation,
  ...reassessment?.instrumentation,
  observeRegionalAdvocacy(event) {
    advocacy?.instrumentation.observeRegionalAdvocacy?.(event);
    reassessment?.instrumentation.observeRegionalAdvocacy?.(event);
  },
  ...(fuelAccounting ? { observeFuelFlow: fuelAccounting.record } : {}),
  ...(procurement ? {
    observeIndustrialProcurement(event: import("../../src/sim/instrumentation").IndustrialProcurementObservation) {
      const { buyerId, resource, phase } = event;
      const key = `${buyerId}/${resource}`;
      let entry = procurement.get(key);
      if (!entry) {
        entry = { buyerId, resource, considered: 0, noCandidate: 0, noRoute: 0, rejected: 0,
          dispatched: 0, delivered: 0, returned: 0, quantities: { dispatched: 0, delivered: 0, returned: 0 } };
        procurement.set(key, entry);
      }
      entry[phase]++;
      if ("quantity" in event) entry.quantities[event.phase] += event.quantity;
    },
  } : {}),
  recordDuration(name, ms) {
    timings[name] = (timings[name] ?? 0) + ms;
    if (name === "production.evaluation") fuelAccounting?.afterProduction();
  },
  incrementCounter(name, amount = 1) { counters[name] = (counters[name] ?? 0) + amount; },
  ...(process.env.WORLD_REDISTRIBUTION_SAMPLES === "1" ? {
    recordRedistributionReview(sample: import("../../src/sim/instrumentation").RedistributionReviewSample) {
      if (redistributionSamples.length < 200) redistributionSamples.push(sample);
    },
  } : {}),
};
const history = observeWorldHistory(world);
const flows = createFlowTotals();
let previous = 0, peakUnits = world.units.length, warDays = 0, unitDays = 0;
let fastMs = 0, slowMs = 0;
const cpu = process.cpuUsage(), start = performance.now();
console.log(JSON.stringify({ scenario, seed, settings, instrumented: !!world.instrumentation,
  subjectPairs, selectedOverlord, seededAcquisitions, initial: summarizeWorld(world), districts: world.mesoRegions.length, days }));
for (const day of days) {
  console.info = history.observeLog;
  try {
    while (world.time.fastTick < day) {
      if (world.instrumentation) {
        const t = performance.now();
        stepSimulationDay(world);
        if (world.time.fastTick % DAYS_PER_SLOW_TICK === 0) slowMs += performance.now() - t;
        else fastMs += performance.now() - t;
      } else stepSimulationDay(world);
      history.sampleDay();
      if (world.time.fastTick % DAYS_PER_SLOW_TICK === 0) {
        sampleFlows(world, flows);
        fuelAccounting?.afterCycle();
        fiscalAccounting?.afterCycle();
        advocacy?.sampleDay();
      }
      warDays += world.wars.length;
      unitDays += world.units.length;
      peakUnits = Math.max(peakUnits, world.units.length);
    }
  } finally {
    history.restoreLog();
  }
  const elapsed = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  const heapBeforeGcBytes = process.memoryUsage().heapUsed;
  global.gc?.();
  const politicalRecords = {
    populations: world.regionalPopulations?.size ?? 0,
    grievances: world.identityGrievances?.size ?? 0,
    identityGovernments: world.nations.filter(({ identityGovernment }) => identityGovernment).length,
    identityHistory: world.nations.reduce((total, nation) => total + (nation.identityGovernment?.decisions.length ?? 0), 0),
    subjects: world.nations.filter(({ subjectGovernment }) => subjectGovernment).length,
    subjectDecisions: world.nations.filter(({ subjectDecision }) => subjectDecision).length,
    regionalCases: world.regionalNegotiations?.size ?? 0,
    regionalRefusalRecords: [...world.regionalNegotiations?.values() ?? []].reduce((sum, talks) =>
      sum + Object.keys(talks.refusals ?? {}).length, 0),
    regionalAgreements: [...world.regionalNegotiations?.values() ?? []].filter(({ status }) => status === "agreed").length,
    regionalStatuses: [...world.regionalNegotiations?.values() ?? []].reduce((counts, { status }) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>),
    regionalDistrust: mean([...world.regionalNegotiations?.values() ?? []].map(({ distrust }) => distrust)),
    nationalLegitimacy: mean(world.nations.filter(isNationActive).map(({ identityStability }) => identityStability?.legitimacy ?? 100)),
    nationalGrievance: mean(world.nations.filter(isNationActive).map(({ identityStability }) => identityStability?.grievance ?? 0)),
    nationalAutonomyDemand: mean(world.nations.filter(isNationActive).map(({ identityStability }) => identityStability?.autonomyDemand ?? 0)),
    subjectAutonomyPressure: mean(world.nations.filter(({ subjectGovernment }) => subjectGovernment)
      .map(({ subjectGovernment }) => subjectGovernment!.autonomy ?? 0)),
    pendingRedistributions: world.recentAcquisitions?.size ?? 0,
    events: world.events?.length ?? 0,
    observedHistory: history.timeline.length,
  };
  console.log(JSON.stringify({ day, since: previous, ...summarizeWorld(world), peakUnits, warDays, unitDays, flows,
    historyCounts: history.counts, wallMs: elapsed, cpuMs: (usage.user + usage.system) / 1000,
    politicalRecords, heapBeforeGcBytes, peakRssKiB: process.resourceUsage().maxRSS, heapBytes: process.memoryUsage().heapUsed,
    ...(fuelAccounting ? { fuelAccounting: fuelAccounting.summarize(), fiscalAccounting: fiscalAccounting?.summarize() } : {}),
    ...(procurement ? { procurementFunnel: [...procurement.values()] } : {}),
    ...(advocacy ? { advocacySchedule, advocacy: advocacy.summarize() } : {}),
    ...(reassessment ? { reassessment: reassessment.summarize() } : {}),
    ...(world.instrumentation ? { fastOnlyMs: fastMs, cycleBoundaryMs: slowMs, timings, counters } : {}),
  }));
  previous = day;
}
if (process.env.WORLD_SIGNATURE === "1") {
  // Run after the performance and memory samples.
  console.log(JSON.stringify({ signature: worldSignature(world) }));
}
if (redistributionSamples.length) console.log(JSON.stringify({ redistributionSamples }));
console.log(JSON.stringify({ history: history.timeline, historyCounts: history.counts }));
