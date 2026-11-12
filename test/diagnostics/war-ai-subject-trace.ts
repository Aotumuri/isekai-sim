import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WorldState } from "../../src/sim/world-state";

// Read-only replay of selected cases, including later wars. No commands,
// simulation RNG, lazy game getters or alternate settlement execution.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const root = resolve(option("--engine-root", "."));
if (execFileSync("git", ["-C", root, "diff", "--", "src", "test"], { encoding: "utf8" })) throw new Error("Commit source first");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const seed = Number(option("--seed", "822748319784"));
const ticks = Number(option("--ticks", "10000"));
const scenario = option("--scenario", "reorganization-heavy");
const parentId = option("--parent", "nation-2");
const childId = option("--child", "nation-3");
const campaign = args.includes("--campaign");
const operations = args.includes("--operations");
if (![seed, ticks].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid integers");
const original = console.info;
console.info = () => undefined;
const world: WorldState = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
  reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
  config: { systems: { warCampaignEnabled: campaign, diplomacyEnabled: true, mobilizationEnabled: true,
    researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
world.wars.forEach((war) => { war.isTest = false; });
const outcomes = createWarOutcomeObserver();
const samples: object[] = [], events: object[] = [];
const settlements = new Map<string, object>();
const simulationEvents = new Map<object, object>();
let lastSlowTick = -1, lastRelations = "";
const priorWars = new Map<string, object>();
function sample(current: WorldState): void {
  outcomes.observe(current);
  for (const event of current.events ?? []) if (!simulationEvents.has(event)) {
    simulationEvents.set(event, structuredClone(event));
  }
  for (const settlement of current.warNegotiations?.settlements ?? []) {
    const key = `${settlement.a}:${settlement.b}:${settlement.atSlowTick}:${settlement.proposerId}`;
    if (!settlements.has(key)) events.push({ type: "settlement", tick: current.time.fastTick, ...structuredClone(settlement) });
    settlements.set(key, structuredClone(settlement));
  }
  const wars = new Map(current.wars.map((w) => [`${w.nationAId}:${w.nationBId}@${w.startedAtFastTick}`,
    { a: w.nationAId, b: w.nationBId, aggressor: w.aggressorId, cause: w.cause, start: w.startedAtFastTick }]));
  for (const [key, war] of wars) if (!priorWars.has(key)) events.push({ type: "war-start", tick: current.time.fastTick, ...war });
  for (const [key, war] of priorWars) if (!wars.has(key)) events.push({ type: "war-end", tick: current.time.fastTick, ...war });
  priorWars.clear(); wars.forEach((value, key) => priorWars.set(key, value));
  const relations = current.nations.map((n) => ({ id: n.id, active: n.macroRegionIds.length > 0,
    subject: n.subjectGovernment ?? null }));
  const fingerprint = JSON.stringify(relations);
  // Autonomy changes frequently; retain complete subject states in slow samples,
  // and emit lifecycle transitions only for active/parent/establishment changes.
  const lifecycle = JSON.stringify(relations.map((n) => [n.id, n.active,
    n.subject?.overlordId, n.subject?.establishedAtFastTick]));
  if (lifecycle !== lastRelations) events.push({ type: "government-change", tick: current.time.fastTick, states: JSON.parse(fingerprint) });
  lastRelations = lifecycle;
  if (current.time.slowTick === lastSlowTick) return;
  lastSlowTick = current.time.slowTick;
  const owners = new Map(current.macroRegions.flatMap((m) => m.mesoRegionIds.map((id) => [id, m.nationId] as const)));
  const nations = [parentId, childId].map((id) => {
    const nation = current.nations.find((n) => n.id === id)!;
    const units = current.units.filter((u) => u.nationId === id && u.domain === "land");
    return { id, owned: nation.macroRegionIds.length,
      regions: [...owners].filter(([, owner]) => owner === id).map(([region]) => region), capital: nation.capitalMesoId,
      subject: structuredClone(nation.subjectGovernment), resources: structuredClone(nation.resources),
      units: units.map((u) => ({ id: u.id, region: u.regionId, owner: owners.get(u.regionId),
        from: u.moveFromId, to: u.moveToId, target: u.moveTargetId, manpower: u.manpower,
        front: current.frontAllocations.frontIdByUnitId.get(u.id),
        reserve: current.strategicReserves.reserveNationByUnitId.get(u.id),
        recovery: current.reorganization.planIdByUnitId.get(u.id),
        retreat: current.retreatPlans.retreatIdByUnitId.get(u.id) })),
      ...(operations ? { focus: structuredClone(current.stalematePressure.assessments.filter((a) => a.nationId === id)),
        operations: structuredClone(current.offensiveOperations.operations.filter((op) => op.nationId === id)
          .map((op) => ({ id: op.id, phase: op.phase, target: op.primaryTargetRegionId,
            focus: op.isSchwerpunktOperation, major: op.isMajorOffensive,
            surplus: op.offensiveSurplusAvailable, assigned: op.assignedStrength,
            units: op.assignedUnitIds, required: [...op.plannedStrengthByApproach],
            readiness: op.readinessCompletion, synchronizationReady: op.synchronizationReady,
            started: op.startedAtTick, phaseStarted: op.phaseStartedAtTick,
            expires: op.expiresAtTick, outcome: op.outcome, reason: op.completionReason }))),
        candidates: structuredClone([...current.offensiveOperations.candidatesByFrontNation.values()]
          .filter((c) => c.nationId === id).map((c) => ({ target: c.primaryTargetRegionId,
            focus: c.isSchwerpunktOperation, major: c.isMajorOffensive,
            surplus: c.offensiveSurplusAvailable, required: [...c.requiredStrengthByApproach],
            onTime: [...c.onTimeStrengthByApproach], feasible: c.feasible,
            rejects: c.rejectionReasons, manifest: c.manifest }))) } : {}),
      campaign: structuredClone(current.warCampaigns?.byNationId.get(nation.id)),
      plans: structuredClone(current.frontPlans.plans.filter((p) => p.nationId === id)) };
  });
  samples.push({ tick: current.time.fastTick, slowTick: current.time.slowTick, nations, wars: [...wars.values()],
    relations: structuredClone([...(current.diplomacy?.relations.values() ?? [])].filter((r) =>
      [r.nationAId, r.nationBId].some((id) => id === parentId || id === childId))) });
}
try { runSimulation(world, { ticks, observe: sample }); } finally { console.info = original; }
const report = { revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTree: execFileSync("git", ["-C", root, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim(),
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  seed, scenario, campaign, operations, ticks, parentId, childId, events, samples, simulationEvents: [...simulationEvents.values()],
  warOutcomes: outcomes.result(), endWorld: summarizeWorld(world) };
const output = option("--output", "diagnostics/war-ai-subject-trace.json.gz");
await writeFile(output, gzipSync(JSON.stringify(report)));
console.log(JSON.stringify({ output, samples: samples.length, events: events.length }));
