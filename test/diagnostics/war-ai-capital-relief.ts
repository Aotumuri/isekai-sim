import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { WORLD_BALANCE } from "../../src/data/balance";
import { getMoveTicksPerRegion } from "../../src/sim/movement";
import { getUnitEquipmentFulfillment, getUnitManpowerRatio } from "../../src/sim/reorganization";
import type { UnitState } from "../../src/sim/unit";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { buildWarAdjacency } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import type { BenchmarkScenarioName } from "../benchmark/types";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const root = resolve(option("--engine-root", "."));
const output = resolve(option("--output", "diagnostics/war-ai-capital-relief.json.gz"));
const diagnosticSeeds = [1022748319780, 1022748319781, 1022748319782, 1022748319783];
const cases: [BenchmarkScenarioName, number][] = [
  ...[822748319780, 822748319790, 822748319792].map((seed): ["stalemate-breaker", number] => ["stalemate-breaker", seed]),
  ...(["matched-war", "stalemate-breaker", "reorganization-heavy"] as const)
    .flatMap((scenario) => diagnosticSeeds.map((seed): [typeof scenario, number] => [scenario, seed])),
];
const seedFilter = option("--seed", "");
const registered = cases.filter(([, seed]) => !seedFilter || String(seed) === seedFilter);
if (!registered.length) throw new Error("A registered development or diagnostic seed is required");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", "src")) throw new Error("Commit engine source first");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts") as typeof import("../scenarios/index");
const { runSimulation } = await load("test/helpers/simulation-driver.ts") as typeof import("../helpers/simulation-driver");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts") as typeof import("../benchmark/war-outcome-observer");
const { summarizeWorld } = await load("test/helpers/world-summary.ts") as typeof import("../helpers/world-summary");
const ticks = 10_000;

function isSpecial(world: WorldState, unit: UnitState): boolean {
  return world.playerNation?.nationId === unit.nationId ||
    world.retreatPlans.retreatIdByUnitId.has(unit.id) ||
    world.reorganization.planIdByUnitId.has(unit.id) ||
    world.strategicReserves.reserveNationByUnitId.has(unit.id) ||
    world.offensiveOperations.operationIdByUnitId.has(unit.id) ||
    world.amphibiousOperations.operationByUnitId.has(unit.id) ||
    world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) ||
    world.collapseAdvances.advanceNationByUnitId.has(unit.id) ||
    (world.militaryAccess?.orders.has(unit.id) ?? false);
}

function isReady(unit: UnitState): boolean {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  return getUnitCombatStrength(unit) > 0 && unit.org >= settings.organizationStartRatio &&
    getUnitManpowerRatio(unit) >= settings.manpowerStartRatio &&
    getUnitEquipmentFulfillment(unit) >= settings.equipmentStartRatio &&
    Number.isFinite(getMoveTicksPerRegion(unit));
}

function assessRelease(
  world: WorldState, nationId: NationId, unit: UnitState, friendly: UnitState[],
) {
  const assignments = world.frontlineCoverage.assignmentByUnitId;
  const affected = new Set([unit.regionId, assignments.get(unit.id)?.targetRegionId ?? unit.regionId]);
  const coverageRatio = WORLD_BALANCE.war.landFront.frontlineCoverage.coveredStrengthRatio;
  return Array.from(affected, (regionId) => {
    const coverageFloor = world.frontlineCoverage.coverages.filter((item) => item.nationId === nationId)
      .flatMap((item) => item.positions)
      .reduce((floor, item) => item.friendlyRegionId === regionId
        ? Math.max(floor, item.requiredStrength * coverageRatio) : floor, 0);
    const supplyFloor = world.supplyDefense.risks.reduce((floor, risk) =>
      risk.nationId === nationId && risk.regionId === regionId &&
      (risk.status === "threatened" || risk.status === "critical")
        ? Math.max(floor, risk.requiredDefenseStrength) : floor, 0);
    const remainingStrength = friendly.reduce((sum, other) => {
      if (other === unit || other.regionId !== regionId || other.moveToId ||
        (other.moveTargetId && other.moveTargetId !== regionId) || isSpecial(world, other)) return sum;
      const target = assignments.get(other.id)?.targetRegionId;
      const holding = target ? target === regionId : other.moveTargetId === regionId;
      return holding ? sum + getUnitCombatStrength(other) : sum;
    }, 0);
    return { regionId, coverageFloor, supplyFloor, remainingStrength };
  });
}

function readReliefOptions(
  world: WorldState, nationId: NationId, capital: MesoRegionId,
  enemyRegions: ReadonlySet<MesoRegionId>, friendly: UnitState[], owners: Map<MesoRegionId, NationId>,
) {
  const land = new Map(world.mesoRegions.filter((meso) => meso.type !== "sea").map((meso) => [meso.id, meso]));
  const nextHop = new Map<MesoRegionId, MesoRegionId>([[capital, capital]]);
  const queue = [capital];
  for (const from of queue) for (const { id } of land.get(from)?.neighbors ?? []) {
    const controlled = (world.occupation.mesoById.get(id) ?? owners.get(id)) === nationId;
    if (!land.has(id) || !controlled || enemyRegions.has(id) || nextHop.has(id)) continue;
    nextHop.set(id, from);
    queue.push(id);
  }
  return friendly.filter((unit) => !isSpecial(world, unit) && isReady(unit))
    .map((unit) => {
      const path = [unit.regionId];
      if (nextHop.has(unit.regionId)) {
        while (path.at(-1) !== capital) path.push(nextHop.get(path.at(-1)!)!);
      }
      const route = path.at(-1) === capital ? path : null;
      const displaced = assessRelease(world, nationId, unit, friendly);
      return {
        id: unit.id, regionId: unit.regionId, moveTargetId: unit.moveTargetId,
        strength: getUnitCombatStrength(unit), organization: unit.org, route,
        ticks: route === null ? null : Math.ceil((route.length - 1) * getMoveTicksPerRegion(unit)),
        displaced, releasable: displaced.every((post) =>
          post.remainingStrength >= Math.max(post.coverageFloor, post.supplyFloor)),
      };
    });
}

function runCase(scenario: BenchmarkScenarioName, seed: number) {
  const world = createScenarioWorld(scenario, {
    seed, quick: true, width: 640, height: 360,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  if (world.wars.length !== 1) throw new Error("Expected a single opening war");
  const [war] = world.wars;
  const defender = world.nations.find((nation) => nation.id === war.defenderId)!;
  const capital = defender.capitalMesoId;
  const outcomes = createWarOutcomeObserver();
  const startFingerprint = createHash("sha256").update(JSON.stringify({
    units: world.units, wars: world.wars, macroRegions: world.macroRegions,
    resources: world.nations.map((nation) => [nation.id, nation.resources]),
  })).digest("hex");
  const snapshots: { tick: number; threat: string; readinessBlocked: number;
    options: ReturnType<typeof readReliefOptions> }[] = [];
  let firstContact: number | null = null;
  let firstLoss: number | null = null;
  let openingEnded = false;

  runSimulation(world, { ticks, observe(current) {
    outcomes.observe(current);
    if (openingEnded) return;
    openingEnded = !current.wars.includes(war);
    const tick = current.time.fastTick;
    const hostile = buildWarAdjacency(current.wars).get(defender.id) ?? new Set<NationId>();
    hostile.add(war.aggressorId);
    const enemyRegions = new Set(current.units.filter((unit) =>
      unit.domain === "land" && hostile.has(unit.nationId)).map((unit) => unit.regionId));
    const capitalBattle = current.battles.some((battle) =>
      battle.mesoId === capital && battle.defenderNationId === defender.id && hostile.has(battle.attackerNationId));
    if (enemyRegions.has(capital) || capitalBattle) firstContact ??= tick;
    const owners = new Map(current.macroRegions.flatMap((macro) =>
      macro.mesoRegionIds.map((id) => [id, macro.nationId] as const)));
    if ((current.occupation.mesoById.get(capital) ?? owners.get(capital)) !== defender.id) firstLoss ??= tick;
    if (firstContact !== null || firstLoss !== null || openingEnded) return;
    const assessment = current.capitalDefense.assessmentsByNationId.get(defender.id);
    if (tick === 0 || !assessment || assessment.evaluatedAtTick !== tick || assessment.threatLevel === "none" ||
      assessment.capitalRegionId !== capital) return;
    const friendly = current.units.filter((unit) => unit.domain === "land" && unit.nationId === defender.id);
    if (friendly.some((unit) => unit.regionId === capital && getUnitCombatStrength(unit) > 0)) return;
    const readinessBlocked = friendly.filter((unit) =>
      !isSpecial(current, unit) && !isReady(unit)).length;
    const options = readReliefOptions(current, defender.id, capital, enemyRegions, friendly, owners);
    snapshots.push({ tick, threat: assessment.threatLevel, readinessBlocked, options });
  } });
  return { scenario, seed, capital, defender: defender.id, startFingerprint, firstContact, firstLoss,
    warOutcomes: outcomes.result(), endWorld: summarizeWorld(world), snapshots };
}

const results = registered.map(([scenario, seed]) => {
  const result = withMutedSimulationLogs(() => runCase(scenario, seed));
  console.log(`${scenario} ${seed}: ${result.snapshots.length} exposed decisions`);
  return result;
});
const report = {
  revision: git("rev-parse", "HEAD"), sourceTree: git("rev-parse", "HEAD:src"),
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  ticks, campaign: true, results,
};
await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report)));
await rename(`${output}.tmp`, output);
