import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";
import type { PeaceTerms } from "../../src/sim/war-negotiations";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const root = resolve(option("--engine-root", "."));
if (execFileSync("git", ["-C", root, "diff", "--", "src", "test"], { encoding: "utf8" })) throw new Error("Commit observed engine first");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const { BenchmarkMetrics } = await load("test/benchmark/metrics.ts");
const { assessPeaceOffer, getWarAdvantage, getPeaceUrgency, whitePeaceTerms } = await load("src/sim/war-negotiations.ts");
const { getPuppetTermsIssue } = await load("src/sim/subject-governments.ts");
const seed = Number(option("--seed", "822748319782"));
const ticks = Number(option("--ticks", "10000"));
if (![seed, ticks].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid integers");
const scenario = option("--scenario", "stalemate-breaker"), campaign = args.includes("--campaign");
const original = console.info;
console.info = () => undefined;
const world: WorldState = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
  reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
  config: { systems: { warCampaignEnabled: campaign, diplomacyEnabled: true, mobilizationEnabled: true,
    researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
world.wars.forEach((war) => { war.isTest = false; });
const outcomes = createWarOutcomeObserver(), decisions: object[] = [];
const settlements = new Map<string, object>();
function treaties(a: NationId, b: NationId) {
  return [...(world.diplomacy?.relations.values() ?? [])].find((r) =>
    [r.nationAId, r.nationBId].includes(a) && [r.nationAId, r.nationBId].includes(b))?.treaties ?? [];
}
function inspect(recipient: NationId, proposer: NationId, kind: "publication" | "acceptance"): void {
  const negotiation = [...(world.warNegotiations?.active.values() ?? [])].find((n) =>
    [n.a, n.b].includes(recipient) && [n.a, n.b].includes(proposer));
  if (!negotiation) throw new Error("Diagnostic signal has no negotiation");
  const offer = negotiation.offers.get(proposer)!;
  const terms = structuredClone(offer.terms);
  const ordinary = !terms.puppetTarget && !terms.partition && !terms.localSubject && !terms.resourceReparation;
  const reciprocal: PeaceTerms = { ...whitePeaceTerms(), demandedRegionIds: terms.offeredRegionIds,
    offeredRegionIds: terms.demandedRegionIds, demandedWeapons: terms.offeredWeapons,
    offeredWeapons: terms.demandedWeapons, truceSeconds: terms.truceSeconds };
  const puppetIssue = getPuppetTermsIssue(world, proposer, recipient);
  const puppetTerms = { ...whitePeaceTerms(), puppetTarget: true,
    demandedWeapons: terms.demandedWeapons, truceSeconds: terms.truceSeconds };
  const truceWindows = [proposer, recipient].flatMap((parent) => {
    const enemy = parent === proposer ? recipient : proposer;
    return world.nations.filter((n) => n.macroRegionIds.length && n.subjectGovernment?.overlordId === parent)
      .map((subject) => {
        const childTreaties = treaties(subject.id, enemy);
        const childTruceUntil = Math.max(world.time.slowTick, ...childTreaties.filter((t) => t.type === "truce")
          .map((t) => t.expiresAtSlowTick ?? world.time.slowTick));
        return { parent, subject: subject.id, enemy, subjectTreaties: structuredClone(childTreaties),
          proposedParentTruceUntil: world.time.slowTick + terms.truceSeconds, childTruceUntil,
          conditionalTruceGapSlowTicks: Math.max(0, world.time.slowTick + terms.truceSeconds - childTruceUntil),
          subjectAlreadyAtWar: world.wars.some((w) => [w.nationAId, w.nationBId].includes(subject.id) &&
            [w.nationAId, w.nationBId].includes(enemy)) };
      });
  });
  decisions.push({ kind, tick: world.time.fastTick, slowTick: world.time.slowTick, recipient, proposer,
    offer: structuredClone(offer), offerAgeSlowTicks: world.time.slowTick - offer.revisedAtSlowTick,
    recipientAssessment: assessPeaceOffer(world, recipient, proposer, terms),
    proposerAssessment: ordinary ? assessPeaceOffer(world, proposer, recipient, reciprocal) : null,
    proposerAssessmentUnsupportedPoliticalTerms: !ordinary,
    puppetAlternative: { issue: puppetIssue, terms: puppetTerms,
      recipientAssessment: puppetIssue ? null : assessPeaceOffer(world, recipient, proposer, puppetTerms) },
    truceWindows, governments: [proposer, recipient].map((id) => {
      const nation = world.nations.find((n) => n.id === id)!;
      return { id, advantage: getWarAdvantage(world, id, id === proposer ? recipient : proposer),
        urgency: getPeaceUrgency(world, id), resources: structuredClone(nation.resources),
        subject: structuredClone(nation.subjectGovernment), character: structuredClone(nation.character),
        campaign: structuredClone(world.warCampaigns?.byNationId.get(id)),
        activeWars: structuredClone(world.wars.filter((w) => [w.nationAId, w.nationBId].includes(id))),
        landUnits: world.units.filter((u) => u.nationId === id && u.domain === "land").length };
    }) });
}
class DecisionMetrics extends BenchmarkMetrics {
  recordDuration(name: string, ms: number) {
    super.recordDuration(name, ms);
    const publication = name.startsWith("diagnostic.peaceOfferPublished.");
    if (!publication && !name.startsWith("diagnostic.peaceOffer.")) return;
    const [, , recipient, proposer] = name.split(".");
    inspect(recipient as NationId, proposer as NationId, publication ? "publication" : "acceptance");
  }
}
try {
  runSimulation(world, { ticks, metrics: new DecisionMetrics(), observe(current: WorldState) {
    outcomes.observe(current);
    for (const s of current.warNegotiations?.settlements ?? []) {
      settlements.set(`${s.a}:${s.b}:${s.atSlowTick}:${s.proposerId}`, structuredClone(s));
    }
  } });
} finally { console.info = original; }
const report = { revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTree: execFileSync("git", ["-C", root, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim(),
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  seed, scenario, campaign, ticks, decisions, settlements: [...settlements.values()],
  warOutcomes: outcomes.result(), endWorld: summarizeWorld(world),
  note: "Isolated diagnostic signals at offer publication and after acceptance validation, before transfers. Match acceptance attempts to observed settlements. Puppet legality/recipient acceptance is not overlord net benefit. Truce gaps are conditional legal windows, not predicted attacks. No commands or simulation RNG calls." };
const output = option("--output", "diagnostics/war-ai-peace-decision-trace.json.gz");
await writeFile(output, gzipSync(JSON.stringify(report)));
console.log(JSON.stringify({ output, decisions: decisions.length }));
