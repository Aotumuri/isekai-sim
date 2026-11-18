import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { pairedBootstrap } from "../helpers/paired-bootstrap";

const paths = process.argv.slice(2);
if (paths.length !== 4) throw new Error("Supply Legacy, R1, candidate sea audits and output path");
const audits = await Promise.all(paths.slice(0, 3).map(async (path) =>
  JSON.parse(gunzipSync(await readFile(path)).toString())));
const sides = audits.map((audit) => audit.results.flatMap((row: any) => row.openingWarSides.map((side: any) => {
  const war = row.warOutcomes.wars.find((w: any) => w.observedAtTick === 0 && w.nationId === side.nationId);
  if (!war) throw new Error("Missing opening side");
  const settlements = row.settlements.filter((s: any) => [s.a, s.b].includes(war.nationId) &&
    [s.a, s.b].includes(war.opponentId) && s.atSlowTick * 10 >= war.startedAtTick &&
    s.atSlowTick * 10 <= (war.endedAtTick ?? audit.ticks));
  const transfers = settlements.map((s: any) => (s.terms.demandedWeapons - s.terms.offeredWeapons) *
    (s.proposerId === side.nationId ? 1 : -1));
  return { seed: row.seed, scenario: row.scenario, nationId: side.nationId, aggressor: side.aggressor,
    startFingerprint: row.startFingerprint, values: {
      objectiveHeld: Number(war.objectiveHeld), survived: Number(war.survived),
      territorialNetValue: war.opponentTerritorySecuredValue - war.homelandLostValue,
      openingWeaponReceipts: transfers.reduce((sum: number, n: number) => sum + Math.max(0, n), 0),
      openingWeaponPayments: transfers.reduce((sum: number, n: number) => sum + Math.max(0, -n), 0),
      openingNetWeapons: transfers.reduce((sum: number, n: number) => sum + n, 0),
      unavailableManpowerWholeEpisode: row.costs[side.nationId]?.unavailableManpower ?? 0,
      productionWeaponsWholeEpisode: row.spending[side.nationId]?.weapons ?? 0,
      productionManpowerWholeEpisode: row.spending[side.nationId]?.manpower ?? 0,
      mobilizationBurdenSecondsWholeEpisode: row.spending[side.nationId]?.burdenSeconds ?? 0,
      openingWarTicksCapped: (war.endedAtTick ?? audit.ticks) - war.startedAtTick,
      warSideCountWholeEpisode: row.warOutcomes.wars.filter((w: any) => w.nationId === side.nationId).length,
    } };
})));
for (const audit of audits) {
  if (audit.ticks !== audits[0].ticks || audit.seedStart !== audits[0].seedStart || audit.seeds !== audits[0].seeds) throw new Error("Incompatible audits");
}
for (const rows of sides.slice(1)) {
  if (rows.length !== sides[0].length) throw new Error("Missing paired rows");
  for (const old of sides[0]) {
    const paired = rows.find((r: any) => r.seed === old.seed && r.scenario === old.scenario && r.nationId === old.nationId);
    if (!paired || paired.aggressor !== old.aggressor || paired.startFingerprint !== old.startFingerprint) throw new Error("Incompatible start");
  }
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    min: sorted[0], max: sorted.at(-1) };
}
const roles = [true, false].map((aggressor) => {
  const rows = sides.map((arm) => arm.filter((r: any) => r.aggressor === aggressor));
  const metrics = Object.keys(rows[0][0].values);
  return { role: aggressor ? "aggressor" : "defender",
    arms: rows.map((arm, i) => ({ revision: audits[i].revision,
      metrics: Object.fromEntries(metrics.map((metric) => [metric, distribution(arm.map((r: any) => r.values[metric]))])) })),
    comparisons: [0, 1].map((control) => ({ versus: control === 0 ? "Legacy" : "R1",
      metrics: Object.fromEntries(metrics.map((metric) => [metric, pairedBootstrap(rows[control].map((r: any) => {
        const next = rows[2].find((n: any) => n.seed === r.seed && n.scenario === r.scenario && n.nationId === r.nationId);
        return next.values[metric] - r.values[metric];
      }))])) })),
  };
});
await writeFile(paths[3], gzipSync(JSON.stringify({ paths: paths.slice(0, 3),
  note: "Opening-war settlements are matched to the opening pair and end time. Whole-episode force/spending include later wars. Opposing roles remain separate; intervals are exploratory per metric, not multiplicity-corrected.", roles, pairedSides: sides })));
console.log(JSON.stringify(roles.map((r) => ({ role: r.role, arms: r.arms.map((a) => ({
  netWeapons: a.metrics.openingNetWeapons.mean,
  unavailableManpower: a.metrics.unavailableManpowerWholeEpisode.mean,
  productionWeapons: a.metrics.productionWeaponsWholeEpisode.mean,
})) }))));
