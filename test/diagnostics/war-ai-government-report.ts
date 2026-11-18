import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { pairedBootstrap } from "../helpers/paired-bootstrap";
import type { createOpeningGovernmentObserver } from "../helpers/war-government-outcome-observer";

type Observer = ReturnType<typeof createOpeningGovernmentObserver>;
type Government = ReturnType<Observer["result"]>[number];
interface Row {
  seed: number; scenario: string; startFingerprint: string;
  openingGovernmentOutcomes: Government[];
  episodeGovernmentStates: ReturnType<Observer["currentStates"]>;
  costs: Record<string, { unavailableManpower: number }>;
  spending: Record<string, { manpower: number; weapons: number; fuel: number; burdenSeconds: number }>;
}
interface Audit {
  revision: string; sourceTree: string; harnessHash: string; observerHash: string;
  ticks: number; seeds: number; seedStart: number; scenarios: string[]; results: Row[];
}
const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Supply government audit paths; first is paired baseline");
const audits: Audit[] = await Promise.all(paths.map(async (path) =>
  JSON.parse(gunzipSync(await readFile(path)).toString())));
const key = (row: Row) => `${row.scenario}:${row.seed}`;
const baseline = new Map(audits[0].results.map((row) => [key(row), row]));
for (const audit of audits) {
  for (const field of ["ticks", "seeds", "seedStart", "scenarios", "harnessHash", "observerHash"] as const) {
    if (JSON.stringify(audit[field]) !== JSON.stringify(audits[0][field])) throw new Error(`Incompatible ${field}`);
  }
  if (new Set(audit.results.map(key)).size !== baseline.size || audit.results.length !== baseline.size ||
      baseline.size !== audit.seeds * audit.scenarios.length) throw new Error("Incomplete or duplicate cases");
  for (const row of audit.results) {
    const before = baseline.get(key(row));
    if (before?.startFingerprint !== row.startFingerprint) throw new Error(`Different starting world ${key(row)}`);
    const opening = (items: Government[]) => items.map((g) =>
      [g.nationId, g.opponentId, g.aggressor, g.startedAtTick, g.openingStatus, g.openingOverlordId]);
    if (JSON.stringify(opening(before.openingGovernmentOutcomes)) !== JSON.stringify(opening(row.openingGovernmentOutcomes))) {
      throw new Error(`Different opening governments ${key(row)}`);
    }
  }
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const describe = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, mean: mean(values), median: (sorted[Math.floor((sorted.length - 1) / 2)] +
    sorted[Math.floor(sorted.length / 2)]) / 2, min: sorted[0], max: sorted.at(-1),
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] };
};
function measurements(row: Row, aggressor: boolean): Record<string, number> {
  const sides = row.openingGovernmentOutcomes.filter((g) => g.aggressor === aggressor);
  if (!sides.length) throw new Error("Missing role");
  const rate = (predicate: (g: Government) => boolean) => mean(sides.map((g) => Number(predicate(g))));
  const ids = [...new Set(sides.map((g) => g.nationId))];
  const states = new Map(row.episodeGovernmentStates.map((s) => [s.nationId, s]));
  const sum = (get: (id: string) => number) => ids.reduce((total, id) => total + get(id), 0);
  return {
    censoredRate: rate((g) => g.endedAtTick === null),
    resolvedGovernmentPreservedRate: rate((g) => g.endedAtTick !== null && g.governmentPreserved),
    observedGovernmentPreservedRate: rate((g) => g.governmentPreserved),
    resolvedOpponentSubjectRate: rate((g) => g.endedAtTick !== null && g.opponentSubjectToUs),
    observedSubjectToOpponentRate: rate((g) => g.overlordId === g.opponentId),
    observedOtherSubjectRate: rate((g) => g.status === "subject" && g.overlordId !== g.opponentId),
    episodeGovernmentPreservedRate: rate((g) => states.get(g.nationId)!.governmentPreserved),
    subjectRelationshipEndedAfterResolvedOpeningRate: rate((g) => g.endedAtTick !== null && g.opponentSubjectToUs &&
      states.get(g.opponentId)!.overlordId !== g.nationId),
    episodeUnavailableManpower: sum((id) => row.costs[id]?.unavailableManpower ?? 0),
    episodeProductionManpower: sum((id) => row.spending[id]?.manpower ?? 0),
    episodeProductionWeapons: sum((id) => row.spending[id]?.weapons ?? 0),
    episodeProductionFuel: sum((id) => row.spending[id]?.fuel ?? 0),
    episodeMobilizationBurdenSeconds: sum((id) => row.spending[id]?.burdenSeconds ?? 0),
  };
}
const summaries = audits.map((audit, i) => ({ path: paths[i], revision: audit.revision, sourceTree: audit.sourceTree,
  scenarios: Object.fromEntries(audit.scenarios.map((scenario) => [scenario,
    Object.fromEntries([true, false].map((aggressor) => {
      const rows = audit.results.filter((r) => r.scenario === scenario).map((r) => measurements(r, aggressor));
      return [aggressor ? "aggressor" : "defender", Object.fromEntries(Object.keys(rows[0]).map((metric) =>
        [metric, describe(rows.map((r) => r[metric]))]))];
    }))])) }));
const paired = audits.slice(1).map((audit, i) => ({ path: paths[i + 1],
  scenarios: Object.fromEntries(audit.scenarios.map((scenario) => [scenario,
    Object.fromEntries([true, false].map((aggressor) => {
      const rows = audit.results.filter((r) => r.scenario === scenario);
      const changes = rows.map((r) => {
        const current = measurements(r, aggressor), before = measurements(baseline.get(key(r))!, aggressor);
        return Object.fromEntries(Object.keys(current).map((metric) => [metric, current[metric] - before[metric]]));
      });
      return [aggressor ? "aggressor" : "defender", Object.fromEntries(Object.keys(changes[0]).map((metric) =>
        [metric, pairedBootstrap(changes.map((r) => r[metric]))]))];
    }))])) }));
console.log(JSON.stringify({ note: "Supplement only; original adoption gates unchanged. Resolved rates use all opening sides as denominator, with censoring reported separately. Costs cover the whole episode, summed once per distinct opening nation within each role. Lost subjects require causal replay; no maintenance failure is inferred. No combined opposing-interest utility.", summaries, paired }, null, 2));
