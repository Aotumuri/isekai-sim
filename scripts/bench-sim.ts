import { performance } from "node:perf_hooks";
import { createWorldConfig } from "../src/data/world-config";
import { createWorld } from "../src/sim/create-world";
import { getPerfSnapshot, resetPerfStats, setPerfEnabled } from "../src/sim/perf";
import { createSimClock, SPEED_MULTIPLIERS } from "../src/sim/time";
import { updateSimulation } from "../src/sim/update";

type ArgMap = Map<string, string>;

function parseArgs(argv: string[]): ArgMap {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      continue;
    }
    const trimmed = raw.slice(2);
    const [key, value] = trimmed.split("=");
    if (value !== undefined) {
      args.set(key, value);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

function readNumber(args: ArgMap, key: string, fallback: number): number {
  const raw = args.get(key);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pickSpeedIndex(speed: number): number {
  let bestIndex = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SPEED_MULTIPLIERS.length; i += 1) {
    const diff = Math.abs(SPEED_MULTIPLIERS[i] - speed);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }
  if (SPEED_MULTIPLIERS[bestIndex] !== speed) {
    console.warn(
      `[bench] speed x${speed} not in table; using x${SPEED_MULTIPLIERS[bestIndex]} instead.`,
    );
  }
  return bestIndex;
}

const args = parseArgs(process.argv.slice(2));
const width = Math.max(100, Math.round(readNumber(args, "width", 2750)));
const height = Math.max(100, Math.round(readNumber(args, "height", 1860)));
const seed = Math.round(readNumber(args, "seed", 123456));
const simMinutes = Math.max(0, readNumber(args, "minutes", 1));
const speed = readNumber(args, "speed", 32);
const fps = Math.max(1, readNumber(args, "fps", 60));
const frameMs = 1000 / fps;
const targetSimMs = simMinutes * 60_000;

const config = createWorldConfig(width, height);
config.seed = seed;

setPerfEnabled(true);
resetPerfStats();

const worldStart = performance.now();
const world = createWorld(config);
const worldElapsedMs = performance.now() - worldStart;

const clock = createSimClock();
clock.speedIndex = pickSpeedIndex(speed);

const startFastTick = world.time.fastTick;
const startSlowTick = world.time.slowTick;
const startSimMs = world.time.elapsedMs;

const start = performance.now();
let updates = 0;
while (world.time.elapsedMs - startSimMs < targetSimMs) {
  updateSimulation(world, clock, frameMs);
  updates += 1;
}
const elapsedMs = performance.now() - start;

const simMs = world.time.elapsedMs - startSimMs;
const fastTicks = world.time.fastTick - startFastTick;
const slowTicks = world.time.slowTick - startSlowTick;
const wallSec = elapsedMs / 1000;
const simSec = simMs / 1000;
const simSpeed = wallSec > 0 ? simSec / wallSec : 0;
const fastTicksPerSec = wallSec > 0 ? fastTicks / wallSec : 0;
const msPerFastTick = fastTicks > 0 ? elapsedMs / fastTicks : 0;

const perfEntries = getPerfSnapshot().sort((a, b) => b.totalMs - a.totalMs);

console.log("[bench] config", {
  width,
  height,
  seed,
  speed: `x${SPEED_MULTIPLIERS[clock.speedIndex]}`,
  fps,
  simMinutes,
});
console.log("[bench] world", {
  microRegions: world.microRegions.length,
  mesoRegions: world.mesoRegions.length,
  macroRegions: world.macroRegions.length,
  nations: world.nations.length,
  units: world.units.length,
  worldGenMs: Number(worldElapsedMs.toFixed(2)),
});
console.log("[bench] result", {
  simMs: Math.round(simMs),
  wallMs: Number(elapsedMs.toFixed(2)),
  updates,
  fastTicks,
  slowTicks,
  simSecPerWallSec: Number(simSpeed.toFixed(2)),
  fastTicksPerSec: Number(fastTicksPerSec.toFixed(2)),
  msPerFastTick: Number(msPerFastTick.toFixed(3)),
});
if (perfEntries.length > 0) {
  console.log("[bench] perf (top 12)");
  for (const entry of perfEntries.slice(0, 12)) {
    console.log(" ", {
      label: entry.label,
      totalMs: Number(entry.totalMs.toFixed(2)),
      avgMs: Number(entry.avgMs.toFixed(4)),
      maxMs: Number(entry.maxMs.toFixed(2)),
      count: entry.count,
    });
  }
}
