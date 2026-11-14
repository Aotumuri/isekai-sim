import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";

// Explicit selected causal intervention, never a production AI policy.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const root = resolve(option("--engine-root", "."));
if (execFileSync("git", ["-C", root, "diff", "--", "src", "test"], { encoding: "utf8" })) throw new Error("Commit engine first");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const seed = Number(option("--seed", "822748319786"));
const ticks = Number(option("--ticks", "10000"));
const decisionTick = Number(option("--decision-tick", "310"));
if (![seed, ticks, decisionTick].every((n) => Number.isSafeInteger(n) && n > 0) ||
  decisionTick % 10 !== 0 || decisionTick >= ticks) throw new Error("Invalid horizon/slow decision tick");
const scenario = option("--scenario", "stalemate-breaker");
const proposer = option("--proposer", "nation-0") as NationId;
const target = option("--target", "nation-1") as NationId;
const defer = args.includes("--defer-revision");
const originalInfo = console.info;
console.info = () => undefined;
const world: WorldState = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
  reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
  config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
    researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
world.wars.forEach((war) => { war.isTest = false; });
const outcomes = createWarOutcomeObserver();
const checkpoints: object[] = [], interventions: object[] = [];
const settlements = new Map<string, object>();
let restore: (() => void) | undefined;
function observe(current: WorldState): void {
  outcomes.observe(current);
  for (const s of current.warNegotiations?.settlements ?? []) {
    settlements.set(`${s.a}:${s.b}:${s.atSlowTick}:${s.proposerId}`, structuredClone(s));
  }
  const now = current.time.fastTick;
  if (![decisionTick - 1, decisionTick, decisionTick + 100, decisionTick + 120].includes(now)) return;
  const negotiation = [...(current.warNegotiations?.active.values() ?? [])].find((n) =>
    [n.a, n.b].includes(proposer) && [n.a, n.b].includes(target));
  const offers = structuredClone([...(negotiation?.offers ?? [])]);
  checkpoints.push({ tick: now, summary: summarizeWorld(current), units: structuredClone(current.units),
    nations: structuredClone(current.nations), wars: structuredClone(current.wars), offers,
    campaigns: structuredClone([...(current.warCampaigns?.byNationId ?? [])]),
    revisionTimers: structuredClone([...(negotiation?.lastRevisionSlowTick ?? [])]) });
  if (now === decisionTick - 1 && defer) {
    assert.ok(negotiation, "Selected war already ended");
    assert.equal(negotiation.automatic.get(proposer), true);
    const prior = negotiation.lastRevisionSlowTick.get(proposer);
    assert.ok(current.time.slowTick + 1 - (prior ?? 0) >= 30, "Revision not due");
    const priorOffer = structuredClone(negotiation.offers.get(proposer));
    negotiation.lastRevisionSlowTick.set(proposer, current.time.slowTick);
    interventions.push({ tick: now, priorTimer: prior, temporaryTimer: current.time.slowTick });
    restore = () => {
      assert.deepEqual(negotiation.offers.get(proposer), priorOffer, "Old standing offer changed during skipped pass");
      if (prior === undefined) negotiation.lastRevisionSlowTick.delete(proposer);
      else negotiation.lastRevisionSlowTick.set(proposer, prior);
      interventions.push({ tick: current.time.fastTick, restoredTimer: prior, standingOfferRetained: true });
    };
  }
  if (now === decisionTick && restore) { restore(); restore = undefined; }
}
try { runSimulation(world, { ticks, observe }); } finally { console.info = originalInfo; }
assert.equal(restore, undefined, "Timer was not restored");
assert.equal(interventions.length, defer ? 2 : 0);
const report = { revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTree: execFileSync("git", ["-C", root, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim(),
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  seed, scenario, ticks, campaign: true, decisionTick, proposer, target, defer,
  interventions, checkpoints, settlements: [...settlements.values()],
  endWorld: summarizeWorld(world), warOutcomes: outcomes.result(),
  note: "Selected diagnostic intervention: delay one proposer revision, restore timer, preserve standing offer and all legal/acceptance rules. Untreated control needs matrix parity; recorded prefix equality is not full hidden-state equality. No population quality claim." };
await writeFile(option("--output", "diagnostics/war-ai-peace-revision-counterfactual.json.gz"), gzipSync(JSON.stringify(report)));
console.log(JSON.stringify({ defer, checkpoints: checkpoints.length, interventions: interventions.length }));
