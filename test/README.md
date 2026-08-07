# Simulation benchmark and regression tests

This directory is the permanent measurement harness for the simulation. It does
not create a Pixi renderer or DOM. World generation and simulation run directly
in Node with a fixed seed.

## Commands

```bash
npm test
npm run test:typecheck
npm run test:sim
npm run benchmark
npm run benchmark:quick
```

The standard benchmark runs `active-war`, seed `822748319788`, 1920x1080 and
3200 fast ticks in throughput mode. The quick command uses a smaller deterministic
world and 200 ticks for development feedback.

Useful options:

```bash
npm run benchmark -- --scenario many-units --ticks 3200
npm run benchmark -- --scenario late-game --seed 822748319788
npm run benchmark -- --mode frame-loop --speed 32 --ticks 3200
npm run benchmark -- --output benchmark-results/before.json
```

`throughput` executes ticks as fast as possible. `frame-loop` calls the production
accumulator/budget update with a fixed frame delta, so it reports the effective
simulation multiplier without waiting in real time.

## Before / After comparison

For a defense-assignment optimization, for example:

```bash
npm run benchmark -- --scenario active-war --output benchmark-results/defense-before.json
# make the implementation change
npm test
npm run benchmark -- --scenario active-war --output benchmark-results/defense-after.json
npm run benchmark:compare -- benchmark-results/defense-before.json benchmark-results/defense-after.json
```

Wall-clock values are reports, not strict test thresholds. Compare counters as
well as time so an apparent speedup caused by skipped work is visible.
`benchmark-results/` is intentionally ignored by Git.

## Scenarios

- `base-world`: fixed-seed generated world.
- `active-war`: deterministic adjacent wars with attack and defense targets.
- `many-units`: active wars plus 600 land units (240 in quick mode).
- `civil-war`: triggers the production civil-war transition and adds a nation.
- `late-game`: active/extinct nations, wars, occupation and many units together.

Scenario setup lives in `test/scenarios/`. Add a setup function, register it in
`test/scenarios/index.ts`, and add its name to `BENCHMARK_SCENARIOS` in
`test/benchmark/types.ts`. Prefer production APIs such as `declareWar`,
`updateCivilWar`, `updateOccupation`, and unit factories. Direct state setup is
acceptable only for state that has no public transition API; update the matching
version when doing so.

## Metrics and counters

`BenchmarkMetrics` records count, total, average, min, max, p50, p95 and p99.
Samples use a 2048-entry ring buffer per metric, so long runs do not retain an
unbounded array. Algorithm counters are totals and do not retain samples.

Production instrumentation points implement the optional interface in
`src/sim/instrumentation.ts`. To add a timed metric:

1. Add its name to `SimulationMetricName`.
2. Read `world.instrumentation` once near the measured code.
3. Call `performance.now()` only when the observer exists.
4. Record the duration with `recordDuration`.

To add a counter, add it to `SimulationCounterName` and call
`incrementCounter` only through the optional observer. World-level gauges such as
active nation, extinct nation, unit, war and battle counts belong in
`summarizeWorld`, not in every tick.

The browser game never installs an observer. Therefore benchmark sample arrays,
Maps, string construction and `performance.now()` calls are absent from normal
simulation execution; only an undefined property check remains at an
instrumentation point.

## Regression tests

Tests use Node's built-in `node:test` runner with `tsx` for TypeScript loading.
They validate semantic invariants rather than snapshotting the full generated
world. Current coverage includes deterministic fixed-tick simulation, nation
lifecycle, capital-scan exclusion, unit targets, war/territory reevaluation,
unreachable targets, shared-cache invalidation, next-hop legality, shortest-path
monotonicity, ID integrity and finite resources/unit state.

Battles can delete units after the AI phase in the same fast tick. Unit-role IDs
are therefore checked after the following `repositionUnits` phase, which is the
point where those derived role lists are refreshed.
