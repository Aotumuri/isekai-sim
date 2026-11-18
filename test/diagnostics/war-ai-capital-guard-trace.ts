import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { UnitId } from "../../src/sim/unit";
import type { NationId } from "../../src/worldgen/nation";
import type { WorldState } from "../../src/sim/world-state";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const root = resolve(option("--engine-root", "."));
const seed = Number(option("--seed", "822748319792"));
const scenario = option("--scenario", "stalemate-breaker");
const ticks = 10_000;
const campaign = args.includes("--campaign");
const role = option("--role", "defender");
if (role !== "defender" && role !== "aggressor") throw new Error("Invalid opening-war role");
const output = resolve(option("--output", "diagnostics/war-ai-capital-guard-trace.json.gz"));
if (!Number.isSafeInteger(seed) || seed < 822_748_319_780 || seed > 822_748_319_799) {
  throw new Error("An R2 development seed is required");
}
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", "src")) throw new Error("Commit engine source first");

const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const { getUnitCombatStrength } = await load("src/sim/unit-strength.ts");
const world: WorldState = createScenarioWorld(scenario, {
  seed, quick: true, width: 640, height: 360,
  reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
  config: { systems: {
    warCampaignEnabled: campaign, diplomacyEnabled: true, mobilizationEnabled: true,
    researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true,
  } },
});
world.wars.forEach((war) => { war.isTest = false; });
const war = world.wars[0];
if (!war || world.wars.length !== 1) throw new Error("Expected exactly one opening war");
const nationId = role === "defender" ? war.defenderId : war.aggressorId;
const opponentId = role === "defender" ? war.aggressorId : war.defenderId;
const nation = world.nations.find((item) => item.id === nationId)!;
const capital = nation.capitalMesoId;
const outcomes = createWarOutcomeObserver();
const transitions: object[] = [];
let previous = "";
let ended = false;

function observe(current: WorldState): void {
  outcomes.observe(current);
  const openingWarActive = current.wars.includes(war);
  if (ended) return;
  const assessment = current.capitalDefense.assessmentsByNationId.get(nationId);
  const occupants = current.units.filter((unit) => unit.domain === "land" && unit.regionId === capital);
  const friendly = occupants.filter((unit) => unit.nationId === nationId);
  // Older engines share the assessment shape but have no reservation index.
  const state: WorldState["capitalDefense"] & { guardByNationId?: Map<NationId, UnitId> } =
    current.capitalDefense;
  const sample = {
    openingWarActive, currentCapital: nation.capitalMesoId,
    controlledBy: current.occupation.mesoById.get(capital) ?? current.macroRegions.find(
      (macro) => macro.mesoRegionIds.includes(capital),
    )?.nationId ?? null,
    threat: assessment?.capitalRegionId === capital ? assessment.threatLevel : "none",
    reservation: state.guardByNationId?.get(nationId) ?? null,
    fuelEmpty: nation.resources.fuel <= 0,
    friendly: friendly.map((unit) => ({
      id: unit.id, positiveCombatStrength: getUnitCombatStrength(unit) > 0,
      target: unit.moveTargetId, front: current.frontAllocations.frontIdByUnitId.get(unit.id) ?? null,
      retreat: current.retreatPlans.retreatIdByUnitId.has(unit.id),
      reorganization: current.reorganization.planIdByUnitId.has(unit.id),
    })),
    enemyPresent: occupants.filter((unit) => unit.nationId === opponentId).map((unit) => unit.id),
    enemyOperations: current.offensiveOperations.operations.filter((operation) =>
      operation.nationId === opponentId && operation.enemyNationId === nationId,
    ).map((operation) => [operation.id, operation.phase, operation.primaryTargetRegionId]),
  };
  const fingerprint = JSON.stringify(sample);
  if (fingerprint !== previous) transitions.push({ tick: current.time.fastTick, ...sample });
  previous = fingerprint;
  ended = !openingWarActive;
}

const info = console.info;
try {
  console.info = () => undefined;
  runSimulation(world, { ticks, observe });
} finally {
  console.info = info;
}
const report = {
  revision: git("rev-parse", "HEAD"), sourceTree: git("rev-parse", "HEAD:src"),
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  scenario, seed, ticks, campaign, role, nationId, opponentId, capital,
  warOutcomes: outcomes.result(), endWorld: summarizeWorld(world), transitions,
};
await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report)));
await rename(`${output}.tmp`, output);
console.log(`${scenario} ${seed}: ${transitions.length} capital transitions`);
