import type { SimulationEvent } from "../../src/sim/simulation-settings";
import { isNationActive } from "../../src/sim/nation-active";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";

type Entry = { day: number; kind: string; detail: unknown };

export function observeWorldHistory(world: WorldState, limit = 1_000) {
  const counts: Record<string, number> = {};
  const timeline: Entry[] = [];
  function record(kind: string, detail: unknown): void {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (timeline.length < limit && kind !== "other-treaty" && kind !== "mandate-retained") {
      timeline.push({ day: world.time.fastTick, kind, detail });
    }
  }

  // Observe synchronous publication before the normal 200-entry log is pruned.
  // The rolling array, its contents, and push's return value retain their semantics.
  const events = world.events ??= [];
  events.push = function (...items: SimulationEvent[]): number {
    for (const event of items) {
      const kind = classify(event.message);
      if (!kind) continue;
      const district = kind.startsWith("regional-")
        ? /, district (meso-[0-9]+):/.exec(event.message)?.[1] as import("../../src/worldgen/meso-region").MesoRegionId | undefined
        : undefined;
      const talks = district && world.regionalNegotiations?.get(district);
      record(kind, { ids: event.nationIds, message: event.message, ...(talks ? { negotiation: { ...talks, refusals: undefined } } : {}) });
    }
    return Array.prototype.push.apply(this, items);
  };

  let owners = new Map(getOwnerByMesoId(world));
  let territoryVersion = world.territoryVersion;
  let nationCount = world.nations.length;
  let active = new Set(world.nations.filter(isNationActive).map(({ id }) => id));
  const warKey = (war: WorldState["wars"][number]) =>
    `${war.id}|${war.nationAId}|${war.nationBId}|${war.startedAtFastTick}`;
  let wars = new Map(world.wars.map((war) => [warKey(war), war]));
  const log = console.info;
  function observeLog(...args: unknown[]): void {
    if (typeof args[0] === "string" && args[0].startsWith("[War]")) record("war-intent-log", args[0]);
  }

  function sampleDay(): void {
    if (territoryVersion !== world.territoryVersion || nationCount !== world.nations.length) {
      const nextOwners = getOwnerByMesoId(world);
      const changes: Record<string, number> = {};
      for (const [district, owner] of nextOwners) {
        const previous = owners.get(district);
        if (previous === owner) continue;
        const key = `${previous ?? "unowned"} -> ${owner}`;
        changes[key] = (changes[key] ?? 0) + 1;
      }
      if (Object.keys(changes).length) record("legal-ownership", changes);
      const nextActive = new Set(world.nations.filter(isNationActive).map(({ id }) => id));
      const founded = world.nations.slice(nationCount).map(({ id }) => id);
      for (const id of founded) record("nation-founded", id);
      for (const id of active) if (!nextActive.has(id)) record("territory-lost", {
        id, exile: world.exileGovernments?.byNationId.get(id)?.status ?? null,
      });
      for (const id of nextActive) if (!active.has(id) && !founded.includes(id)) record("territory-restored", id);
      active = nextActive;
      nationCount = world.nations.length;
      territoryVersion = world.territoryVersion;
      owners = new Map(nextOwners);
    }
    if (wars.size || world.wars.length) {
      const nextWars = new Map(world.wars.map((war) => [warKey(war), war]));
      for (const [key, war] of nextWars) if (!wars.has(key)) record("war-start", {
        key, aggressor: war.aggressorId, defender: war.defenderId, cause: war.cause ?? null,
        territorialDemand: war.ultimatumRegionIds?.length ?? 0,
      });
      for (const id of wars.keys()) if (!nextWars.has(id)) record("war-end", id);
      wars = nextWars;
    }
  }

  return { counts, timeline, sampleDay, observeLog, restoreLog: () => { console.info = log; } };
}

function classify(message: string): string | undefined {
  const redistribution = /^Subject territorial redistribution \(([^)]+)\)/.exec(message);
  if (redistribution) return `redistribution-${redistribution[1]}`;
  const subject = /: subject (integration|independence|self-government) \(([^)]+)\)\./.exec(message);
  if (subject) return `subject-${subject[1]}-${subject[2]}`;
  if (message.includes(", district ")) {
    if (message.includes(" demanded ")) return "regional-demand";
    if (message.includes(" received an offer ")) return "regional-offer";
    if (message.includes(" secured ")) return "regional-agreement";
    if (message.includes(" negotiations failed")) return "regional-rejection";
    if (message.includes(" withdrew the demand")) return "regional-withdrawal";
    if (message.includes(" agreement was violated")) return "regional-violation";
  }
  if (message.startsWith("Territorial ")) return "transfer-" + message.split(/[ :]/)[1];
  if (message.includes("installed a puppet government")) return "puppet";
  if (/after a period of (assimilation|administrative alignment)/.test(message)) return "integration";
  if (message.startsWith("Revolution in ")) return "revolution";
  if (message.includes("declared independence")) return "subject-independence";
  if (message.includes(" is no longer a subject of ")) return "subject-release";
  if (message.includes("signed peace (")) return "peace";
  if (message.includes(" issued an ultimatum to ")) return "ultimatum";
  if (message.includes(" accepted the territorial exchange ")) return "peaceful-exchange";
  if (message.includes("signed alliance")) return "alliance";
  if (/ signed (trade|non-aggression|truce)\./.test(message)) return "other-treaty";
  if (message.includes("domestic unrest")) return "unrest";
  if (/ (election|royal succession) brought to power /.test(message)) return "mandate-change";
  if (/ (election|royal succession) retained /.test(message)) return "mandate-retained";
  if (message.includes("government in exile") || message.includes("liberated homeland")) return "exile";
  if (/adopted (cultural and religious assimilation|common administration)/.test(message)) return "assimilation-policy";
  if (/ adopted (protected|tolerated|autonomous|assimilation|restricted) treatment for /.test(message)) return "group-treatment";
  if (/ recognized .* \((ancestry|culture|faith)\)\./.test(message)) return "identity-recognition";
  if (/proclaimed its (self-determination program|state faith)/.test(message)) return "legacy-recognition";
  if (message.includes("reunification movement")) return "nationalist-claim";
}
